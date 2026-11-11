//! Capture context, the `Inspectable` trait and object publication (spec sections 2 and 4).
use crate::builders::{DetailsBuilder, TableBuilder, View};
use crate::limits::Limits;
use crate::value::Value;

/// A diagnostic raised while computing a view: a programming error or a schema violation, never a successful empty view.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewError {
    pub category: String,
    pub message: String,
}

impl ViewError {
    pub fn not_implemented(what: &str) -> ViewError {
        ViewError { category: "not-implemented".to_string(), message: format!("NOT_IMPLEMENTED: {what}") }
    }
}

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

/// Successful views stay alongside per-view diagnostics.
pub struct ViewSetResult {
    pub views: Vec<(ViewMeta, ViewResult)>,
}

impl ViewSetResult {
    pub fn new() -> ViewSetResult { ViewSetResult { views: Vec::new() } }
    pub fn push(&mut self, meta: ViewMeta, result: ViewResult) { self.views.push((meta, result)); }
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
    json: serde_json::Value,
}

impl ObjectGraph {
    pub fn to_json(&self) -> serde_json::Value { self.json.clone() }
}

/// Passed to view functions: bounded builders, references and the object's own fields.
pub struct Context {
    _private: (),
}

impl Context {
    pub fn details(&mut self) -> DetailsBuilder { DetailsBuilder { fields: Vec::new() } }
    pub fn table(&mut self) -> TableBuilder { TableBuilder { rows: Vec::new() } }
    /// Publishes `value` (once per active traversal; a second reference to the same borrowed value returns the same object)
    /// and returns a reference. Beyond a bound it returns `ObjectRef::NotCaptured`, not an error.
    pub fn reference<T: Inspectable>(&mut self, value: &T) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Context::reference"))
    }
    /// As `reference`, with a declared domain key. Distinct values with the same key stay distinct objects.
    pub fn reference_keyed<T: Inspectable>(&mut self, value: &T, key: &str) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Context::reference_keyed"))
    }
    /// As `reference`, naming the edge (default: the current view id).
    pub fn reference_named<T: Inspectable>(&mut self, name: &str, value: &T) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Context::reference_named"))
    }
    /// The general form: an edge name and an optional domain key.
    pub fn reference_full<T: Inspectable>(&mut self, name: &str, key: Option<&str>, value: &T) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Context::reference_full"))
    }
    /// A declared field of the object being captured (tagged values survive in the object record).
    pub fn field(&mut self, name: &str, value: impl Into<Value>) {}
    pub fn label(&mut self, text: &str) {}
    /// Marks the current view's consistency best-effort (separate reads without a consistent domain snapshot).
    pub fn best_effort(&mut self) {}
}

/// Owns the visited map, the limits and the emitted records of one invocation.
pub struct Capture {
    options: CaptureOptions,
}

impl Capture {
    pub fn new(options: CaptureOptions) -> Capture { Capture { options } }
    /// Publishes a root object: assigns its id, computes its views and follows declared references.
    pub fn publish<T: Inspectable>(&mut self, value: &T) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Capture::publish"))
    }
    /// As `publish`, with a declared domain key.
    pub fn publish_keyed<T: Inspectable>(&mut self, value: &T, key: &str) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Capture::publish_keyed"))
    }
    /// As `publish`, with a capture-local identity token: publishing the same token again returns the first object.
    pub fn publish_with_identity<T: Inspectable>(&mut self, value: &T, identity: &str) -> Result<ObjectRef, ViewError> {
        Err(ViewError::not_implemented("Capture::publish_with_identity"))
    }
    pub fn finish(self) -> ObjectGraph {
        ObjectGraph { json: serde_json::json!({}) }
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

/// Publishes at an execution point. Borrows without moving. With no active collector it returns `Inactive` and does no traversal.
pub fn inspect<T: Inspectable>(value: &T) -> InspectOutcome {
    InspectOutcome::Failed("NOT_IMPLEMENTED: inspect".to_string())
}

/// Runs `body` with `options` as the active collector for this thread and returns what it published.
pub fn with_capture(options: CaptureOptions, body: impl FnOnce()) -> ObjectGraph {
    body();
    Capture::new(options).finish()
}
