//! Capture context, the `Inspectable` trait and object publication (spec sections 2 and 4; docs/v1-red-contract.md sections 3-5).
//!
//! A capture assigns an object id on publication (registration order, never an address), then computes the object's views and
//! follows the references the views declare. Everything is bounded while it is built: a bound that bites yields a not-captured
//! reference and a named omission, never an error and never silence.
use crate::builders::{Budget, DetailsBuilder, TableBuilder, View, ViewBody};
use crate::json::{canonical, sha256_hex};
use crate::limits::Limits;
use crate::value::{EncodeStats, Value};
use serde_json::{json, Map, Value as Json};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::time::Instant;

/// A diagnostic raised while computing a view: a programming error or a schema violation, never a successful empty view.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewError {
    pub category: String,
    pub message: String,
}

impl ViewError {
    pub fn new(category: &str, message: impl Into<String>) -> ViewError {
        ViewError { category: category.to_string(), message: message.into() }
    }
}

impl std::fmt::Display for ViewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.category, self.message)
    }
}

impl std::error::Error for ViewError {}

pub type ViewResult = Result<View, ViewError>;

/// Static metadata of one view (also carried by the catalogue descriptor).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewMeta {
    pub id: &'static str,
    pub title: &'static str,
    pub question: &'static str,
    pub component: &'static str,
    pub priority: i32,
}

/// One computed view of an object: the result, and whether the view declared its reads best-effort.
pub struct ViewEntry {
    pub meta: ViewMeta,
    pub result: ViewResult,
    pub best_effort: bool,
}

/// Successful views stay alongside per-view diagnostics.
pub struct ViewSetResult {
    pub views: Vec<ViewEntry>,
}

impl ViewSetResult {
    pub fn new() -> ViewSetResult { ViewSetResult { views: Vec::new() } }

    pub fn push(&mut self, meta: ViewMeta, result: ViewResult) {
        self.views.push(ViewEntry { meta, result, best_effort: false });
    }

    /// Runs one view function under `cx`: a panic fails this view alone (spec decision 10), and a `cx.best_effort()` call made by
    /// the view is recorded on its entry. The `views` attribute generates one call per annotated method.
    pub fn run<F: FnOnce(&mut Context<'_>) -> ViewResult>(&mut self, cx: &mut Context<'_>, meta: ViewMeta, view: F) {
        cx.enter_view(meta.id);
        let outcome = catch_unwind(AssertUnwindSafe(|| view(cx)));
        let best_effort = cx.leave_view();
        let result = outcome.unwrap_or_else(|payload| Err(ViewError::new("view-exception", format!("view {} panicked: {}", meta.id, panic_message(payload.as_ref())))));
        self.views.push(ViewEntry { meta, result, best_effort });
    }
}

impl Default for ViewSetResult {
    fn default() -> Self { ViewSetResult::new() }
}

pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "panic with a non-text payload".to_string()
    }
}

/// The base contract: works on a borrowed value; no `Serialize`, no `'static`, no `Send` required.
pub trait Inspectable {
    /// The stable repository-owned type id, e.g. `vigil::watch::WatchFile`. An associated const so that example descriptors can name the
    /// type of their return value in a static.
    const PANEWEFT_TYPE_ID: &'static str;
    fn paneweft_type_id(&self) -> &'static str {
        Self::PANEWEFT_TYPE_ID
    }
    fn views(&self, cx: &mut Context) -> ViewSetResult;
}

/// A reference to a captured object, or an explicit not-captured state (never an error for bounds).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ObjectRef {
    Captured(String),
    NotCaptured { reason: String },
}

impl ObjectRef {
    pub fn id(&self) -> Option<&str> { match self { ObjectRef::Captured(id) => Some(id.as_str()), _ => None } }
    pub fn is_captured(&self) -> bool { matches!(self, ObjectRef::Captured(_)) }

    /// The wire `ObjectRef` (a row target).
    pub(crate) fn to_json(&self) -> Json {
        match self {
            ObjectRef::Captured(id) => json!({"object": id}),
            ObjectRef::NotCaptured { reason } => json!({"notCaptured": {"reason": reason}}),
        }
    }
}

/// Everything a capture needs to be reproducible.
#[derive(Clone, Debug)]
pub struct CaptureOptions {
    pub capture_id: String,
    pub run_id: String,
    pub invocation_id: String,
    pub limits: Limits,
}

impl Default for CaptureOptions {
    fn default() -> Self {
        CaptureOptions { capture_id: "c1".into(), run_id: "run-1".into(), invocation_id: "inv-1".into(), limits: Limits::default() }
    }
}

/// The finished immutable result: a `paneweft.object-graph/1` document.
#[derive(Clone, Debug, PartialEq)]
pub struct ObjectGraph {
    json: Json,
}

impl ObjectGraph {
    pub fn to_json(&self) -> Json { self.json.clone() }
}

struct ObjectRec {
    id: String,
    type_id: &'static str,
    domain_key: Option<String>,
    label: Option<String>,
    fields: Map<String, Json>,
    edges: Vec<Json>,
    views: Vec<String>,
    depth: u32,
}

/// Why a bound refused a reference, as the wire reason and the name under which the omission is counted.
#[derive(Clone, Copy)]
enum Bound {
    Depth,
    Objects,
    References,
    RootBytes,
    CollectionBytes,
    Roots,
}

impl Bound {
    fn reason(self) -> &'static str {
        match self {
            Bound::Depth => "depth-limit",
            Bound::Objects => "object-limit",
            Bound::References => "reference-limit",
            Bound::RootBytes => "root-bytes-limit",
            Bound::CollectionBytes | Bound::Roots => "collection-limit",
        }
    }

    fn omitted_name(self) -> &'static str {
        match self {
            Bound::Depth => "depth",
            Bound::Objects => "objects",
            Bound::References => "references",
            Bound::RootBytes => "rootBytes",
            Bound::CollectionBytes => "collectionBytes",
            Bound::Roots => "roots",
        }
    }
}

pub(crate) struct State {
    options: CaptureOptions,
    objects: Vec<ObjectRec>,
    views: Vec<Json>,
    pages: Vec<Json>,
    diagnostics: Vec<Json>,
    roots: Vec<String>,
    /// Typed address -> object index, valid only inside one publish call (an address is not an identity across calls).
    by_address: HashMap<(usize, &'static str), usize>,
    by_token: HashMap<String, usize>,
    path: Vec<usize>,
    references: u64,
    omitted: BTreeMap<String, u64>,
    bytes_root: u64,
    bytes_total: u64,
    /// Time spent publishing children, so a parent view's budget measures only its own computation.
    nested_ns: Rc<Cell<u128>>,
}

fn next_action(category: &str) -> &'static str {
    match category {
        "view-exception" => "Fix the panic in the named view function, then recollect the example.",
        "output-schema" => "Fix the view so it builds a valid component (columns, unique ids, declared component), then recollect.",
        "reference" => "Publish the target with cx.reference before using it as a row target.",
        "limit" => "Select fewer fields or rows, or ask the owner for a larger limit, then recollect.",
        "registration" => "Declare each view id once and register the module in the manifest or test binary.",
        "assertion" => "Read the failed claim in the example, fix the code or the expectation, then recollect.",
        _ => "Read the message, fix the named source, then recollect the example.",
    }
}

const DIAGNOSTIC_CATEGORIES: [&str; 10] = ["compiler", "typecheck", "assertion", "view-exception", "output-schema", "reference", "limit", "registration", "renderer", "runner"];

impl State {
    fn new(options: CaptureOptions) -> State {
        State {
            options,
            objects: Vec::new(),
            views: Vec::new(),
            pages: Vec::new(),
            diagnostics: Vec::new(),
            roots: Vec::new(),
            by_address: HashMap::new(),
            by_token: HashMap::new(),
            path: Vec::new(),
            references: 0,
            omitted: BTreeMap::new(),
            bytes_root: 0,
            bytes_total: 0,
            nested_ns: Rc::new(Cell::new(0)),
        }
    }

    fn limits(&self) -> Limits {
        self.options.limits
    }

    pub(crate) fn add_diagnostic(&mut self, category: &str, message: &str, view_id: Option<&str>, example_id: Option<&str>, id: Option<String>) -> String {
        let category = if DIAGNOSTIC_CATEGORIES.contains(&category) { category } else { "view-exception" };
        let id = id.unwrap_or_else(|| format!("diag-{}-{}", self.options.capture_id, self.diagnostics.len() + 1));
        let mut entry = Map::new();
        entry.insert("id".into(), json!(id));
        entry.insert("category".into(), json!(category));
        entry.insert("message".into(), json!(crate::value::cut_str(message, 2000).0));
        if let Some(view) = view_id {
            entry.insert("viewId".into(), json!(view));
        }
        if let Some(example) = example_id {
            entry.insert("exampleId".into(), json!(example));
        }
        entry.insert("nextAction".into(), json!(next_action(category)));
        self.diagnostics.push(Json::Object(entry));
        id
    }

    fn count(&mut self, name: &str, amount: u64) {
        if amount > 0 {
            *self.omitted.entry(name.to_string()).or_insert(0) += amount;
        }
    }

    /// Which bound (if any) refuses a NEW object now. `parent_depth` is `None` for a root.
    fn refusal(&self, parent_depth: Option<u32>) -> Option<Bound> {
        let limits = self.limits();
        if parent_depth.is_some() && self.references >= u64::from(limits.references) {
            return Some(Bound::References);
        }
        if let Some(depth) = parent_depth {
            if depth + 1 > limits.depth {
                return Some(Bound::Depth);
            }
        }
        if self.objects.len() as u64 >= u64::from(limits.objects) {
            return Some(Bound::Objects);
        }
        if parent_depth.is_none() && self.roots.len() as u64 >= u64::from(limits.roots) {
            return Some(Bound::Roots);
        }
        if self.bytes_root >= limits.root_bytes && parent_depth.is_some() {
            return Some(Bound::RootBytes);
        }
        if self.bytes_total >= limits.collection_bytes {
            return Some(Bound::CollectionBytes);
        }
        None
    }

    fn refuse(&mut self, parent: &Option<(usize, String)>, bound: Bound) -> ObjectRef {
        self.count(bound.omitted_name(), 1);
        if let Some((index, name)) = parent {
            self.objects[*index].edges.push(json!({"name": name, "kind": "not-captured", "reason": bound.reason()}));
        }
        ObjectRef::NotCaptured { reason: bound.reason().to_string() }
    }

    /// Registers `value` (or finds it again) and, for a new object, computes its views before returning.
    fn open<T: Inspectable>(&mut self, parent: Option<(usize, String)>, key: Option<&str>, value: &T, token: Option<&str>) -> ObjectRef {
        let address = (std::mem::size_of::<T>() > 0).then(|| (value as *const T as *const () as usize, std::any::type_name::<T>()));
        let existing = match token {
            Some(token) => self.by_token.get(token).copied(),
            None => address.and_then(|key| self.by_address.get(&key).copied()),
        };
        if let Some(index) = existing {
            let id = self.objects[index].id.clone();
            if let Some((owner, name)) = &parent {
                if self.references >= u64::from(self.limits().references) {
                    return self.refuse(&parent, Bound::References);
                }
                self.references += 1;
                let kind = if self.path.contains(&index) { "cycle" } else { "alias" };
                self.objects[*owner].edges.push(json!({"name": name, "kind": kind, "target": id}));
            }
            return ObjectRef::Captured(id);
        }
        let parent_depth = parent.as_ref().map(|(owner, _)| self.objects[*owner].depth);
        if let Some(bound) = self.refusal(parent_depth) {
            return self.refuse(&parent, bound);
        }
        let index = self.objects.len();
        let id = format!("o{}", index + 1);
        self.objects.push(ObjectRec { id: id.clone(), type_id: value.paneweft_type_id(), domain_key: key.map(str::to_string), label: None, fields: Map::new(), edges: Vec::new(), views: Vec::new(), depth: parent_depth.map_or(0, |d| d + 1) });
        if let Some(address) = address {
            self.by_address.insert(address, index);
        }
        if let Some(token) = token {
            self.by_token.insert(token.to_string(), index);
        }
        match &parent {
            Some((owner, name)) => {
                self.references += 1;
                self.objects[*owner].edges.push(json!({"name": name, "kind": "child", "target": id}));
            }
            None => {
                self.roots.push(id.clone());
                self.bytes_root = 0;
            }
        }
        self.path.push(index);
        let started = Instant::now();
        let outcome = {
            let mut cx = Context { state: self, object: index, view: None, view_best_effort: false, any_best_effort: false };
            catch_unwind(AssertUnwindSafe(|| {
                let set = value.views(&mut cx);
                (set, cx.any_best_effort)
            }))
        };
        self.path.pop();
        self.nested_ns.set(self.nested_ns.get() + started.elapsed().as_nanos());
        match outcome {
            Ok((set, any_best_effort)) => {
                for entry in set.views {
                    self.record_view(index, entry, any_best_effort);
                }
            }
            Err(payload) => {
                let message = format!("views() of {} panicked: {}", self.objects[index].type_id, panic_message(payload.as_ref()));
                self.add_diagnostic("view-exception", &message, None, None, None);
            }
        }
        let size = self.object_json(index).to_string().len() as u64;
        self.bytes_root += size;
        self.bytes_total += size;
        ObjectRef::Captured(id)
    }

    fn record_view(&mut self, index: usize, entry: ViewEntry, object_best_effort: bool) {
        let ViewEntry { meta, result, best_effort } = entry;
        let object_id = self.objects[index].id.clone();
        if self.objects[index].views.iter().any(|existing| existing == meta.id) {
            self.add_diagnostic("registration", &format!("object {object_id} computed two views with the id {}", meta.id), Some(meta.id), None, None);
            return;
        }
        let view = match result {
            Ok(view) => view,
            Err(error) => {
                self.add_diagnostic(&error.category, &error.message, Some(meta.id), None, None);
                return;
            }
        };
        let consistency = (best_effort || object_best_effort).then_some("best-effort");
        let mut record = Map::new();
        record.insert("viewId".into(), json!(meta.id));
        record.insert("objectId".into(), json!(object_id));
        record.insert("title".into(), json!(meta.title));
        record.insert("question".into(), json!(meta.question));
        record.insert("component".into(), json!(meta.component));
        record.insert("priority".into(), json!(meta.priority));
        record.insert("evidence".into(), json!({"provenance": "observed", "runId": self.options.run_id}));
        match view.body {
            ViewBody::Unsupported(reason) => {
                let reason = crate::value::cut_str(&reason, 500).0.to_string();
                let mut completeness = json!({"status": "unsupported", "reason": reason});
                if let Some(mode) = consistency {
                    completeness["consistency"] = json!(mode);
                }
                record.insert("completeness".into(), completeness);
                record.insert("unsupportedReason".into(), json!(reason));
                record.insert("pages".into(), json!([]));
            }
            ViewBody::Built(built) => {
                if built.component != meta.component {
                    let message = format!("view {} declares component {:?} but built a {:?}", meta.id, meta.component, built.component);
                    self.add_diagnostic("output-schema", &message, Some(meta.id), None, None);
                    return;
                }
                let mut completeness = Map::new();
                if built.omitted.is_empty() {
                    completeness.insert("status".into(), json!("complete"));
                } else {
                    completeness.insert("status".into(), json!("partial"));
                    completeness.insert("reason".into(), json!(if built.omitted.contains_key("rows") { "row-limit" } else { "string-limit" }));
                    let omitted: Map<String, Json> = built.omitted.iter().map(|(name, count)| (name.clone(), json!({"known": true, "count": count}))).collect();
                    completeness.insert("omitted".into(), Json::Object(omitted));
                    for (name, count) in &built.omitted {
                        self.count(name, *count);
                    }
                }
                if let Some(mode) = consistency {
                    completeness.insert("consistency".into(), json!(mode));
                }
                if let Some(millis) = built.over_budget_ms {
                    let message = format!("view {} spent {millis} ms of its own computation; the cooperative budget is {} ms", meta.id, self.limits().view_budget_ms);
                    self.add_diagnostic("limit", &message, Some(meta.id), None, None);
                }
                record.insert("completeness".into(), Json::Object(completeness));
                record.insert("data".into(), built.data);
                let mut page_refs = Vec::new();
                for (offset, page) in built.pages.iter().enumerate() {
                    page_refs.push(json!({"index": offset + 1, "pageId": page.page_id, "rowCount": page.rows.len()}));
                    self.pages.push(json!({"pageId": page.page_id, "viewId": meta.id, "objectId": object_id, "index": offset + 1, "rows": page.rows}));
                }
                record.insert("pages".into(), Json::Array(page_refs));
                if let Some(total) = built.rows_total {
                    record.insert("rowsTotal".into(), json!(total));
                }
            }
        }
        let record = Json::Object(record);
        let size = record.to_string().len() as u64;
        self.bytes_root += size;
        self.bytes_total += size;
        self.objects[index].views.push(meta.id.to_string());
        self.views.push(record);
    }

    fn object_json(&self, index: usize) -> Json {
        let object = &self.objects[index];
        let label = object.label.clone().unwrap_or_else(|| object.domain_key.clone().unwrap_or_else(|| object.type_id.rsplit("::").next().unwrap_or(object.type_id).to_string()));
        let label = crate::value::cut_str(&label, 256).0.to_string();
        let fields = Json::Object(object.fields.clone());
        let hash_input = json!({"domainKey": object.domain_key, "fields": fields, "label": label, "typeId": object.type_id});
        json!({
            "id": object.id,
            "typeId": object.type_id,
            "domainKey": object.domain_key,
            "label": label,
            "fields": fields,
            "edges": object.edges,
            "views": object.views,
            "contentHash": sha256_hex(&canonical(&hash_input)),
        })
    }

    fn finish(self) -> ObjectGraph {
        let objects: Vec<Json> = (0..self.objects.len()).map(|index| self.object_json(index)).collect();
        let completeness = if self.omitted.is_empty() {
            json!({"status": "complete"})
        } else {
            let omitted: Map<String, Json> = self.omitted.iter().map(|(name, count)| (name.clone(), json!({"known": true, "count": count}))).collect();
            json!({"status": "partial", "omitted": omitted})
        };
        ObjectGraph {
            json: json!({
                "schemaVersion": "paneweft.object-graph/1",
                "captureId": self.options.capture_id,
                "runId": self.options.run_id,
                "invocationId": self.options.invocation_id,
                "roots": self.roots,
                "objects": objects,
                "views": self.views,
                "pages": self.pages,
                "diagnostics": self.diagnostics,
                "limits": self.options.limits.to_json(),
                "completeness": completeness,
            }),
        }
    }
}

/// Passed to view functions: bounded builders, references and the object's own fields.
pub struct Context<'a> {
    state: &'a mut State,
    object: usize,
    view: Option<&'static str>,
    view_best_effort: bool,
    any_best_effort: bool,
}

impl<'a> Context<'a> {
    pub(crate) fn enter_view(&mut self, id: &'static str) {
        self.view = Some(id);
        self.view_best_effort = false;
    }

    pub(crate) fn leave_view(&mut self) -> bool {
        self.view = None;
        std::mem::take(&mut self.view_best_effort)
    }

    fn budget(&self) -> Budget {
        Budget::start(self.state.nested_ns.clone(), self.state.limits().view_budget_ms)
    }

    pub fn details(&mut self) -> DetailsBuilder { DetailsBuilder::new(self.state.limits(), self.budget()) }
    pub fn table(&mut self) -> TableBuilder { TableBuilder::new(self.state.limits(), self.budget()) }

    /// Publishes `value` (once per active traversal; a second reference to the same borrowed value returns the same object)
    /// and returns a reference. Beyond a bound it returns `ObjectRef::NotCaptured`, not an error.
    pub fn reference<T: Inspectable>(&mut self, value: &T) -> Result<ObjectRef, ViewError> {
        self.reference_full(self.view.unwrap_or("reference"), None, value)
    }
    /// As `reference`, with a declared domain key. Distinct values with the same key stay distinct objects.
    pub fn reference_keyed<T: Inspectable>(&mut self, value: &T, key: &str) -> Result<ObjectRef, ViewError> {
        self.reference_full(self.view.unwrap_or("reference"), Some(key), value)
    }
    /// As `reference`, naming the edge (default: the current view id).
    pub fn reference_named<T: Inspectable>(&mut self, name: &str, value: &T) -> Result<ObjectRef, ViewError> {
        self.reference_full(name, None, value)
    }
    /// The general form: an edge name and an optional domain key.
    pub fn reference_full<T: Inspectable>(&mut self, name: &str, key: Option<&str>, value: &T) -> Result<ObjectRef, ViewError> {
        if name.is_empty() {
            return Err(ViewError::new("reference", "an edge name must not be empty"));
        }
        let name = crate::value::cut_str(name, 256).0.to_string();
        Ok(self.state.open(Some((self.object, name)), key, value, None))
    }
    /// A declared field of the object being captured (tagged values survive in the object record).
    pub fn field(&mut self, name: &str, value: impl Into<Value>) {
        let mut stats = EncodeStats::default();
        let encoded = value.into().encode(&self.state.limits(), &mut stats);
        self.state.count("strings", stats.strings);
        self.state.objects[self.object].fields.insert(name.to_string(), encoded);
    }
    pub fn label(&mut self, text: &str) {
        self.state.objects[self.object].label = Some(text.to_string());
    }
    /// Marks the current view's consistency best-effort (separate reads without a consistent domain snapshot).
    pub fn best_effort(&mut self) {
        self.view_best_effort = true;
        self.any_best_effort = true;
    }
}

/// Owns the visited map, the limits and the emitted records of one invocation.
pub struct Capture {
    state: State,
}

impl Capture {
    pub fn new(options: CaptureOptions) -> Capture { Capture { state: State::new(options) } }

    fn publish_root<T: Inspectable>(&mut self, value: &T, key: Option<&str>, token: Option<&str>) -> Result<ObjectRef, ViewError> {
        self.state.by_address.clear();
        Ok(self.state.open(None, key, value, token))
    }

    /// Publishes a root object: assigns its id, computes its views and follows declared references.
    pub fn publish<T: Inspectable>(&mut self, value: &T) -> Result<ObjectRef, ViewError> {
        self.publish_root(value, None, None)
    }
    /// As `publish`, with a declared domain key.
    pub fn publish_keyed<T: Inspectable>(&mut self, value: &T, key: &str) -> Result<ObjectRef, ViewError> {
        self.publish_root(value, Some(key), None)
    }
    /// As `publish`, with a capture-local identity token: publishing the same token again returns the first object.
    pub fn publish_with_identity<T: Inspectable>(&mut self, value: &T, identity: &str) -> Result<ObjectRef, ViewError> {
        self.publish_root(value, None, Some(identity))
    }
    pub(crate) fn add_diagnostic(&mut self, category: &str, message: &str, example_id: Option<&str>, id: Option<String>) -> String {
        self.state.add_diagnostic(category, message, None, example_id, id)
    }
    /// True when the capture holds a diagnostic that makes the capture failed (a view fault; bounds and notes do not).
    pub(crate) fn has_fault(&self) -> bool {
        self.state.diagnostics.iter().any(|d| matches!(d["category"].as_str(), Some("view-exception" | "output-schema" | "reference" | "registration")))
    }
    pub(crate) fn diagnostic_ids(&self) -> Vec<String> {
        self.state.diagnostics.iter().filter_map(|d| d["id"].as_str().map(str::to_string)).collect()
    }
    pub fn finish(self) -> ObjectGraph {
        self.state.finish()
    }
}

/// What `inspect` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InspectOutcome {
    /// No collector is active: nothing was traversed.
    Inactive,
    Published(ObjectRef),
    Failed(String),
}

thread_local! {
    /// The active collectors of this thread; the last one receives `inspect` calls.
    static ACTIVE: RefCell<Vec<Capture>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn activate(capture: Capture) {
    ACTIVE.with(|active| active.borrow_mut().push(capture));
}

pub(crate) fn deactivate() -> Option<Capture> {
    ACTIVE.with(|active| active.borrow_mut().pop())
}

/// Publishes at an execution point. Borrows without moving. With no active collector it returns `Inactive` and does no traversal.
pub fn inspect<T: Inspectable>(value: &T) -> InspectOutcome {
    let Some(mut capture) = deactivate() else { return InspectOutcome::Inactive };
    let outcome = match capture.publish(value) {
        Ok(reference) => InspectOutcome::Published(reference),
        Err(error) => InspectOutcome::Failed(error.to_string()),
    };
    activate(capture);
    outcome
}

/// Runs `body` with `options` as the active collector for this thread and returns what it published.
pub fn with_capture(options: CaptureOptions, body: impl FnOnce()) -> ObjectGraph {
    activate(Capture::new(options));
    let outcome = catch_unwind(AssertUnwindSafe(body));
    let capture = deactivate().expect("the collector activated above is still on the stack");
    if let Err(payload) = outcome {
        std::panic::resume_unwind(payload);
    }
    capture.finish()
}
