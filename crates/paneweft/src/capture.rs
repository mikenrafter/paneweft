//! Capture context, the `Inspectable` trait and object publication (spec sections 2 and 4; docs/v1-red-contract.md sections 3-5).
//!
//! A capture assigns an object id on publication (registration order, never an address), then computes the object's views and
//! follows the references the views declare. Everything is bounded while it is built: a bound that bites yields a not-captured
//! reference and a named omission, never an error and never silence.
use crate::builders::{Budget, DetailsBuilder, TableBuilder, View, ViewBody};
use crate::json::{canonical, sha256_hex};
use crate::limits::Limits;
use crate::bounded::{bytes_of, emit, emit_string, page_frame, serialize_graph, Charge, Ledger};
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

/// The bytes reserved for the record frame of ONE invocation of a view on ONE object (S23). A view id is not a key: an object's child may run
/// the same view while its parent's invocation is still open, and a refused invocation never held a reservation at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Reservation {
    object: usize,
    invocation: u64,
}

/// One computed view of an object: the result, and whether the view declared its reads best-effort.
pub struct ViewEntry {
    pub meta: ViewMeta,
    pub result: ViewResult,
    pub best_effort: bool,
    /// What `Context::enter_view` reserved for this invocation; `None` when no reservation was made (a pushed result, a refused view).
    pub(crate) reservation: Option<Reservation>,
}

/// Successful views stay alongside per-view diagnostics.
pub struct ViewSetResult {
    pub views: Vec<ViewEntry>,
}

impl ViewSetResult {
    pub fn new() -> ViewSetResult { ViewSetResult { views: Vec::new() } }

    pub fn push(&mut self, meta: ViewMeta, result: ViewResult) {
        self.views.push(ViewEntry { meta, result, best_effort: false, reservation: None });
    }

    /// Runs one view function under `cx`: a panic fails this view alone (spec decision 10), and a `cx.best_effort()` call made by
    /// the view is recorded on its entry. The `views` attribute generates one call per annotated method.
    pub fn run<F: FnOnce(&mut Context<'_>) -> ViewResult>(&mut self, cx: &mut Context<'_>, meta: ViewMeta, view: F) {
        let Some(reservation) = cx.enter_view(meta) else {
            // no room in the byte budget even for the frame of the view record: it is not run, and the omission is named
            let message = format!("view {} was not run: the byte budget of this capture is used up", meta.id);
            self.views.push(ViewEntry { meta, result: Err(ViewError::new("limit", message)), best_effort: false, reservation: None });
            return;
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| view(cx)));
        let best_effort = cx.leave_view();
        let result = outcome.unwrap_or_else(|payload| Err(ViewError::new("view-exception", format!("view {} panicked: {}", meta.id, panic_message(payload.as_ref())))));
        self.views.push(ViewEntry { meta, result, best_effort, reservation: Some(reservation) });
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
    text: String,
    emergency: bool,
}

impl ObjectGraph {
    pub fn to_json(&self) -> Json { self.json.clone() }
    /// The document as it is written: the text the bounded serializer counted is the text that goes to the file.
    pub fn text(&self) -> &str { &self.text }
    /// The size of the document in bytes.
    pub fn bytes(&self) -> u64 { self.text.len() as u64 }
    /// True when the final measure found the document over its bound and the empty marked graph was written instead. Never expected.
    pub fn emergency(&self) -> bool { self.emergency }
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
    /// The bytes of the label the ledger was charged for.
    label_bytes: u64,
    /// The bytes each declared field was charged: its name, the colon and its encoded value.
    field_bytes: HashMap<String, u64>,
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
    /// Capture-local identity token -> object index. The only way two references become one object (S9): a borrowed address cannot
    /// be trusted, because the slot of a dropped temporary is reused by the next one and a value can change between two references.
    by_token: HashMap<String, usize>,
    path: Vec<usize>,
    references: u64,
    omitted: BTreeMap<String, u64>,
    /// The bytes every part of the document is charged to as it is built (S2): object records, field values, edges, view records and their
    /// data, stored page bodies and diagnostics, each by the size of the text it becomes. It starts with the document's own frame.
    ledger: Rc<Ledger>,
    sealed: bool,
    faulted: bool,
    /// What `Context::enter_view` already paid for the frame of each open view record, and what the view itself charged, by object and
    /// invocation (S23).
    reservations: HashMap<Reservation, (u64, Rc<Charge>)>,
    /// The next invocation number of a view.
    next_invocation: u64,
    /// Time spent publishing children, so a parent view's budget measures only its own computation.
    nested_ns: Rc<Cell<u128>>,
}

/// Every name under which a capture counts what it left out.
const OMISSION_NAMES: [&str; 13] = ["collectionBytes", "depth", "diagnostics", "fields", "labels", "objects", "references", "rootBytes", "roots", "rows", "strings", "values", "views"];

/// The hash an object record carries is 64 hex digits; its place is paid for before the fields that it covers exist.
fn content_hash_placeholder() -> String { "0".repeat(64) }

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
        let limits = options.limits;
        let widest: Map<String, Json> = OMISSION_NAMES.iter().map(|name| ((*name).to_string(), json!({"known": true, "count": u64::MAX}))).collect();
        let frame = bytes_of(&document(&options, &[], &[], &[], &[], &[], json!({"status": "partial", "omitted": widest})));
        State {
            options,
            objects: Vec::new(),
            views: Vec::new(),
            pages: Vec::new(),
            diagnostics: Vec::new(),
            roots: Vec::new(),
            by_token: HashMap::new(),
            path: Vec::new(),
            references: 0,
            omitted: BTreeMap::new(),
            ledger: Rc::new(Ledger::new(limits.root_bytes, limits.collection_bytes, frame)),
            sealed: frame > limits.collection_bytes,
            faulted: false,
            reservations: HashMap::new(),
            next_invocation: 0,
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
        if matches!(category, "view-exception" | "output-schema" | "reference" | "registration") {
            self.faulted = true;
        }
        // a diagnostic is charged like everything else; when even it does not fit it is counted, and a fault still fails the capture
        let entry = Json::Object(entry);
        if self.ledger.take(bytes_of(&entry) + u64::from(!self.diagnostics.is_empty())) {
            self.diagnostics.push(entry);
        } else {
            self.count("diagnostics", 1);
        }
        id
    }

    /// Charges and stores a declared field. The name is charged as the text it becomes, then the value is encoded against what is left; what
    /// does not fit is cut and counted.
    fn set_field(&mut self, object: usize, name: &str, value: Value) {
        let known = self.objects[object].fields.contains_key(name);
        if known {
            self.ledger.give(self.objects[object].field_bytes.get(name).copied().unwrap_or(0));
        }
        let separator = u64::from(!known && !self.objects[object].field_bytes.is_empty());
        let Some(key) = emit_string(name, self.ledger.spare().saturating_sub(separator + 1)).filter(|key| self.ledger.take(separator + key.bytes + 1)) else {
            self.count("fields", 1);
            return;
        };
        let before = self.ledger.used();
        let mut stats = EncodeStats::default();
        let encoded = value.encode_with(&self.limits(), &mut stats, &self.ledger, 0);
        self.objects[object].field_bytes.insert(name.to_string(), key.bytes + 1 + (self.ledger.used() - before));
        self.count("strings", stats.strings);
        self.count("values", stats.values);
        self.objects[object].fields.insert(name.to_string(), encoded);
    }

    fn set_label(&mut self, object: usize, text: &str) {
        let label = crate::value::cut_str(text, 256).0.to_string();
        let bytes = bytes_of(&Json::String(label.clone()));
        let old = self.objects[object].label_bytes;
        if bytes > old && !self.ledger.take(bytes - old) {
            self.count("labels", 1);
            return;
        }
        if bytes < old {
            self.ledger.give(old - bytes);
        }
        self.objects[object].label = Some(label);
        self.objects[object].label_bytes = bytes;
    }

    /// Records an edge if the budget has room for it; reports whether it did.
    fn add_edge(&mut self, object: usize, edge: Json) -> bool {
        if !self.ledger.take(bytes_of(&edge) + u64::from(!self.objects[object].edges.is_empty())) {
            return false;
        }
        self.objects[object].edges.push(edge);
        true
    }

    /// The byte bound that refuses `bytes` more, if any.
    fn byte_refusal(&self, bytes: u64, is_root: bool) -> Option<Bound> {
        if bytes <= self.ledger.spare() {
            return None;
        }
        Some(if !is_root && self.ledger.reason() == crate::bounded::CutReason::RootBytes { Bound::RootBytes } else { Bound::CollectionBytes })
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
        None
    }

    fn refuse(&mut self, parent: &Option<(usize, String)>, bound: Bound) -> ObjectRef {
        self.count(bound.omitted_name(), 1);
        if let Some((index, name)) = parent {
            self.add_edge(*index, json!({"name": name, "kind": "not-captured", "reason": bound.reason()}));
        }
        ObjectRef::NotCaptured { reason: bound.reason().to_string() }
    }

    /// Registers `value` (or finds it again) and, for a new object, computes its views before returning.
    fn open<T: Inspectable>(&mut self, parent: Option<(usize, String)>, key: Option<&str>, value: &T, token: Option<&str>) -> ObjectRef {
        let existing = token.and_then(|token| self.by_token.get(token).copied());
        if let Some(index) = existing {
            let id = self.objects[index].id.clone();
            if let Some((owner, name)) = &parent {
                if self.references >= u64::from(self.limits().references) {
                    return self.refuse(&parent, Bound::References);
                }
                let kind = if self.path.contains(&index) { "cycle" } else { "alias" };
                if !self.add_edge(*owner, json!({"name": name, "kind": kind, "target": id})) {
                    let bound = self.byte_refusal(u64::MAX, false).unwrap_or(Bound::CollectionBytes);
                    return self.refuse(&parent, bound);
                }
                self.references += 1;
            }
            return ObjectRef::Captured(id);
        }
        let parent_depth = parent.as_ref().map(|(owner, _)| self.objects[*owner].depth);
        if let Some(bound) = self.refusal(parent_depth) {
            return self.refuse(&parent, bound);
        }
        if parent.is_none() {
            self.ledger.start_root(); // a root starts a fresh root budget
        }
        let index = self.objects.len();
        let id = format!("o{}", index + 1);
        // the record of the object (and the edge that reaches it) is charged before the object exists: no room, no object
        let type_id = value.paneweft_type_id();
        // a domain key is at most 256 characters in the schema; a longer one is cut (and counted), not kept whole
        let (domain_key, key_cut) = match key {
            Some(key) => {
                let (kept, omitted) = crate::value::cut_str(key, 256);
                (Some(kept.to_string()), omitted > 0)
            }
            None => (None, false),
        };
        let default_label = crate::value::cut_str(&domain_key.clone().unwrap_or_else(|| type_id.rsplit("::").next().unwrap_or(type_id).to_string()), 256).0.to_string();
        let child_edge = parent.as_ref().map(|(_, name)| json!({"name": name, "kind": "child", "target": id}));
        // the record of the object, its entry in the root list and the edge that reaches it are charged before the object exists: no room, no object
        let record = bytes_of(&json!({"id": id, "typeId": type_id, "domainKey": domain_key, "label": default_label, "fields": {}, "edges": [], "views": [], "contentHash": content_hash_placeholder()})) + u64::from(!self.objects.is_empty());
        let listed = if parent.is_none() { bytes_of(&json!(id)) + u64::from(!self.roots.is_empty()) } else { 0 };
        let edge = match (&child_edge, &parent) {
            (Some(edge), Some((owner, _))) => bytes_of(edge) + u64::from(!self.objects[*owner].edges.is_empty()),
            _ => 0,
        };
        if let Some(bound) = self.byte_refusal(record + listed + edge, parent.is_none()) {
            return self.refuse(&parent, bound);
        }
        self.ledger.take(record + listed);
        if key_cut {
            self.count("strings", 1);
        }
        let label_bytes = bytes_of(&json!(default_label));
        self.objects.push(ObjectRec { id: id.clone(), type_id, domain_key, label: None, fields: Map::new(), edges: Vec::new(), views: Vec::new(), depth: parent_depth.map_or(0, |d| d + 1), label_bytes, field_bytes: HashMap::new() });
        if let Some(token) = token {
            self.by_token.insert(token.to_string(), index);
        }
        match &parent {
            Some((owner, _)) => {
                self.references += 1;
                if let Some(edge) = child_edge {
                    self.add_edge(*owner, edge);
                }
            }
            None => {
                self.roots.push(id.clone());
            }
        }
        self.path.push(index);
        let started = Instant::now();
        let outcome = {
            let mut cx = Context { state: self, object: index, charge: None, loose: Vec::new(), view: None, view_best_effort: false, any_best_effort: false };
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let set = value.views(&mut cx);
                (set, cx.any_best_effort)
            }));
            for charge in std::mem::take(&mut cx.loose) {
                cx.state.ledger.give(charge.bytes());
            }
            outcome
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
                // the set that held the open invocations is gone: their reservations are returned, or they stay spent for the whole capture
                let lost: Vec<Reservation> = self.reservations.keys().filter(|key| key.object == index).copied().collect();
                for key in lost {
                    if let Some((prepaid, charge)) = self.reservations.remove(&key) {
                        self.ledger.give(prepaid + charge.bytes());
                    }
                }
                let message = format!("views() of {} panicked: {}", self.objects[index].type_id, panic_message(payload.as_ref()));
                self.add_diagnostic("view-exception", &message, None, None, None);
            }
        }
        ObjectRef::Captured(id)
    }

    /// Settles a view against the text it becomes: the record, its stored pages and its entries in the lists that name them are measured by the
    /// serializer, and the difference to what was charged while the view was built is charged or given back. A view that no longer fits is dropped.
    fn record_view(&mut self, index: usize, entry: ViewEntry, object_best_effort: bool) {
        let ViewEntry { meta, result, best_effort, reservation } = entry;
        let object_id = self.objects[index].id.clone();
        // only THIS invocation's reservation is settled: a child that ran the same view (or was refused) holds, or gives back, its own
        let paid = reservation.and_then(|key| self.reservations.remove(&key)).map_or(0, |(prepaid, charge)| prepaid + charge.bytes());
        if self.objects[index].views.iter().any(|existing| existing == meta.id) {
            self.ledger.give(paid);
            self.add_diagnostic("registration", &format!("object {object_id} computed two views with the id {}", meta.id), Some(meta.id), None, None);
            return;
        }
        let view = match result {
            Ok(view) => view,
            Err(error) => {
                self.ledger.give(paid);
                self.add_diagnostic(&error.category, &error.message, Some(meta.id), None, None);
                return;
            }
        };
        let consistency = (best_effort || object_best_effort).then_some("best-effort");
        let mut pending_pages: Vec<Json> = Vec::new();
        let mut counted: Vec<(String, u64)> = Vec::new();
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
                    self.ledger.give(paid);
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
                    counted.extend(built.omitted.iter().map(|(name, count)| (name.clone(), *count)));
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
                    pending_pages.push(json!({"pageId": page.page_id, "viewId": meta.id, "objectId": object_id, "index": offset + 1, "rows": page.rows}));
                }
                record.insert("pages".into(), Json::Array(page_refs));
                if let Some(total) = built.rows_total {
                    record.insert("rowsTotal".into(), json!(total));
                }
            }
        }
        let record = Json::Object(record);
        let mut exact = bytes_of(&record) + u64::from(!self.views.is_empty()) + bytes_of(&json!(meta.id)) + u64::from(!self.objects[index].views.is_empty());
        for (offset, page) in pending_pages.iter().enumerate() {
            exact += bytes_of(page) + u64::from(!self.pages.is_empty() || offset > 0);
        }
        if exact > paid && !self.ledger.take(exact - paid) {
            self.ledger.give(paid);
            self.count("views", 1);
            let message = format!("view {} of object {object_id} was dropped: the byte budget of this capture is used up", meta.id);
            self.add_diagnostic("limit", &message, Some(meta.id), None, None);
            return;
        }
        if exact < paid {
            self.ledger.give(paid - exact);
        }
        for (name, amount) in counted {
            self.count(&name, amount);
        }
        self.pages.extend(pending_pages);
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

    /// The finished document, serialized once by the bounded serializer. When the bound cannot hold even the empty document, or the measure of
    /// the text disagrees with the ledger, the empty marked graph is written (the host refuses the first, and the second is a defect).
    fn finish(self) -> ObjectGraph {
        let omitted: Map<String, Json> = self.omitted.iter().map(|(name, count)| (name.clone(), json!({"known": true, "count": count}))).collect();
        let completeness = if omitted.is_empty() { json!({"status": "complete"}) } else { json!({"status": "partial", "omitted": omitted}) };
        let empty = || document(&self.options, &[], &[], &[], &[], &[], json!({"status": "partial", "omitted": {"collectionBytes": {"known": true, "count": self.omitted.get("collectionBytes").copied().unwrap_or(0).max(1)}}}));
        if self.sealed {
            let text = emit(&empty());
            return ObjectGraph { json: serde_json::from_str(&text.text).expect("the document is JSON"), text: text.text, emergency: false };
        }
        let objects: Vec<Json> = (0..self.objects.len()).map(|index| self.object_json(index)).collect();
        let document = document(&self.options, &self.roots, &objects, &self.views, &self.pages, &self.diagnostics, completeness);
        let emission = serialize_graph(&document, self.options.limits.collection_bytes, empty);
        let json = if emission.emergency { serde_json::from_str(&emission.text).expect("the document is JSON") } else { document };
        ObjectGraph { json, text: emission.text, emergency: emission.emergency }
    }
}

/// The document, member by member. The frame (everything but the lists) is what the ledger was charged for before any content.
fn document(options: &CaptureOptions, roots: &[String], objects: &[Json], views: &[Json], pages: &[Json], diagnostics: &[Json], completeness: Json) -> Json {
    json!({
        "schemaVersion": "paneweft.object-graph/1",
        "captureId": options.capture_id,
        "runId": options.run_id,
        "invocationId": options.invocation_id,
        "roots": roots,
        "objects": objects,
        "views": views,
        "pages": pages,
        "diagnostics": diagnostics,
        "limits": options.limits.to_json(),
        "completeness": completeness,
    })
}

/// Passed to view functions: bounded builders, references and the object's own fields.
pub struct Context<'a> {
    state: &'a mut State,
    object: usize,
    /// What the view being computed has charged; set for the length of one view.
    charge: Option<Rc<Charge>>,
    /// What builders created outside a view (their result is pushed, not run) have charged. `State::open` gives it back before the pushed
    /// entries are settled, and each entry then pays for the text it becomes.
    loose: Vec<Rc<Charge>>,
    view: Option<&'static str>,
    view_best_effort: bool,
    any_best_effort: bool,
}

impl<'a> Context<'a> {
    /// Pays for the frame of the view record BEFORE the view runs, so a field or table that takes all the room cannot leave its own view
    /// without one; `record_view` settles the difference. Returns the reservation, or `None` (and counts the omission) when there is no room for the frame.
    pub(crate) fn enter_view(&mut self, meta: ViewMeta) -> Option<Reservation> {
        let object_id = self.state.objects[self.object].id.clone();
        let frame = json!({"viewId": meta.id, "objectId": object_id, "title": meta.title, "question": meta.question, "component": meta.component, "priority": meta.priority, "evidence": {"provenance": "observed", "runId": self.state.options.run_id}, "completeness": {"status": "partial", "reason": "row-limit", "omitted": {"rows": {"known": true, "count": u64::MAX}, "strings": {"known": true, "count": u64::MAX}}}, "data": 0, "rowsTotal": u64::MAX, "pages": []});
        let prepaid = bytes_of(&frame) + bytes_of(&json!(meta.id)) + 2;
        if !self.state.ledger.take(prepaid) {
            self.state.count("views", 1);
            return None;
        }
        let reservation = Reservation { object: self.object, invocation: self.state.next_invocation };
        self.state.next_invocation += 1;
        let charge = Rc::new(Charge::new(self.state.ledger.clone()));
        self.state.reservations.insert(reservation, (prepaid, charge.clone()));
        self.charge = Some(charge);
        self.view = Some(meta.id);
        self.view_best_effort = false;
        Some(reservation)
    }

    pub(crate) fn leave_view(&mut self) -> bool {
        self.view = None;
        self.charge = None;
        std::mem::take(&mut self.view_best_effort)
    }

    fn budget(&self) -> Budget {
        Budget::start(self.state.nested_ns.clone(), self.state.limits().view_budget_ms)
    }

    fn charge(&mut self) -> Rc<Charge> {
        if let Some(charge) = &self.charge {
            return charge.clone();
        }
        let charge = Rc::new(Charge::new(self.state.ledger.clone()));
        self.loose.push(charge.clone());
        charge
    }

    pub fn details(&mut self) -> DetailsBuilder {
        let charge = self.charge();
        DetailsBuilder::new(self.state.limits(), self.budget(), charge)
    }
    pub fn table(&mut self) -> TableBuilder {
        let (object, view, page_rows) = (self.state.objects[self.object].id.clone(), self.view.unwrap_or("").to_string(), self.state.limits().page_rows);
        let charge = self.charge();
        TableBuilder::new(self.state.limits(), self.budget(), charge, Box::new(move |index| page_frame(&object, &view, index, page_rows)))
    }

    /// Publishes `value` as a NEW observation and returns a reference. Beyond a bound it returns `ObjectRef::NotCaptured`, not an error.
    ///
    /// A borrowed address is not an identity (S9): the slot of a dropped temporary is reused by the next one, and a value may change between
    /// two references, so two references to "the same address" are not known to be the same observation. A value that is shared, or that
    /// a cycle returns to, is referenced with [`Context::reference_with_identity`], which makes the sharing explicit.
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
    /// The general form: an edge name and an optional domain key. Every call is a new observation.
    pub fn reference_full<T: Inspectable>(&mut self, name: &str, key: Option<&str>, value: &T) -> Result<ObjectRef, ViewError> {
        self.reference_identified(name, key, value, None)
    }
    /// As `reference_full`, naming the observation: a later reference (or a root published with `publish_with_identity`) that carries the
    /// same capture-local `identity` is the SAME object, as an `alias` edge, or a `cycle` edge when it returns to an ancestor.
    pub fn reference_with_identity<T: Inspectable>(&mut self, name: &str, key: Option<&str>, value: &T, identity: &str) -> Result<ObjectRef, ViewError> {
        self.reference_identified(name, key, value, Some(identity))
    }
    fn reference_identified<T: Inspectable>(&mut self, name: &str, key: Option<&str>, value: &T, identity: Option<&str>) -> Result<ObjectRef, ViewError> {
        if name.is_empty() {
            return Err(ViewError::new("reference", "an edge name must not be empty"));
        }
        let name = crate::value::cut_str(name, 256).0.to_string();
        Ok(self.state.open(Some((self.object, name)), key, value, identity))
    }
    /// A declared field of the object being captured (tagged values survive in the object record).
    pub fn field(&mut self, name: &str, value: impl Into<Value>) {
        self.state.set_field(self.object, name, value.into());
    }
    pub fn label(&mut self, text: &str) {
        self.state.set_label(self.object, text);
    }
    /// Marks the current view's consistency best-effort (separate reads without a consistent domain snapshot).
    pub fn best_effort(&mut self) {
        self.view_best_effort = true;
        self.any_best_effort = true;
    }
}

/// Owns the identity tokens, the limits and the emitted records of one invocation.
pub struct Capture {
    state: State,
}

impl Capture {
    pub fn new(options: CaptureOptions) -> Capture { Capture { state: State::new(options) } }

    fn publish_root<T: Inspectable>(&mut self, value: &T, key: Option<&str>, token: Option<&str>) -> Result<ObjectRef, ViewError> {
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
        self.state.faulted
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
