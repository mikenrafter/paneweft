//! Shared test support: fixture loading, the language-neutral value and scenario interpreters, and a WatchFile fixture modelled on
//! vigil's `WatchFile` (borrowed, not `Serialize`, with a `summary` that may contain log content and must never be captured).
#![allow(dead_code)]
use paneweft::{Capture, CaptureOptions, Context, Inspectable, Limits, Value, ViewMeta, ViewSetResult};
use serde_json::Value as Json;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Mutex;

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/v1")
}

pub fn load(relative: &str) -> Json {
    let path = fixtures_dir().join(relative);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("fixture {} unreadable: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("fixture {} is not JSON: {error}", path.display()))
}

/// Process-wide guard for tests that set environment variables.
pub static ENVIRONMENT: Mutex<()> = Mutex::new(());

/// Unwraps a result and panics with context and the error when it fails.
pub fn must<T, E: std::fmt::Debug>(result: Result<T, E>, what: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{what}: expected Ok, got {error:?}"),
    }
}

// ---- language-neutral value specs ------------------------------------------------------------------------------------------

pub fn limits_from(overrides: &Json) -> Limits {
    let mut limits = Limits { depth: 4, objects: 1000, references: 4000, root_bytes: 2 * 1024 * 1024, string_bytes: 16 * 1024, page_rows: 100, collection_bytes: 32 * 1024 * 1024, roots: 100, view_rows: 10_000, view_budget_ms: 100 };
    if let Some(map) = overrides.as_object() {
        for (key, value) in map {
            let n = value.as_u64().expect("limit override must be an integer");
            match key.as_str() {
                "depth" => limits.depth = n as u32,
                "objects" => limits.objects = n as u32,
                "references" => limits.references = n as u32,
                "rootBytes" => limits.root_bytes = n,
                "stringBytes" => limits.string_bytes = n,
                "pageRows" => limits.page_rows = n as u32,
                "collectionBytes" => limits.collection_bytes = n,
                "roots" => limits.roots = n as u32,
                "viewRows" => limits.view_rows = n as u32,
                "viewBudgetMs" => limits.view_budget_ms = n,
                other => panic!("unknown limit override {other}"),
            }
        }
    }
    limits
}

pub fn value_from_spec(spec: &Json) -> Value {
    use base64::Engine;
    match spec["kind"].as_str().expect("spec has a kind") {
        "null" => Value::Null,
        "bool" => Value::Bool(spec["value"].as_bool().unwrap()),
        "int" => Value::Int(spec["decimal"].as_str().unwrap().parse::<i128>().unwrap()),
        "float" => match spec["special"].as_str() {
            Some("NaN") => Value::Float(f64::NAN),
            Some("Infinity") => Value::Float(f64::INFINITY),
            Some("-Infinity") => Value::Float(f64::NEG_INFINITY),
            Some("-0") => Value::Float(-0.0),
            Some(other) => panic!("unknown float special {other}"),
            None => Value::Float(spec["number"].as_f64().unwrap()),
        },
        "bytes" => Value::Bytes(base64::engine::general_purpose::STANDARD.decode(spec["base64"].as_str().unwrap()).unwrap()),
        "absent" => Value::Absent,
        "redacted" => Value::Redacted(spec["reason"].as_str().map(|r| r.to_string())),
        "unsupported" => Value::Unsupported(spec["reason"].as_str().unwrap().to_string()),
        "string" => match spec.get("repeat") {
            Some(repeat) => Value::Str(repeat["unit"].as_str().unwrap().repeat(repeat["count"].as_u64().unwrap() as usize)),
            None => Value::Str(spec["text"].as_str().unwrap().to_string()),
        },
        "list" => Value::List(spec["items"].as_array().unwrap().iter().map(value_from_spec).collect()),
        "map" => Value::Map(spec["entries"].as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_string(), value_from_spec(&pair[1]))).collect()),
        other => panic!("unknown value kind {other}"),
    }
}

// ---- scenario nodes (fixtures/v1/graphs) -----------------------------------------------------------------------------------

pub struct Node {
    pub type_id: &'static str,
    pub key: Option<String>,
    pub label: String,
    pub fields: Vec<(String, Value)>,
    pub links: RefCell<Vec<(String, Rc<Node>)>>,
}

const NODE_VIEW: ViewMeta = ViewMeta { id: "node.details", title: "Node", question: "What is this node?", component: "shape", priority: 10 };

impl Inspectable for Node {
    const PANEWEFT_TYPE_ID: &'static str = "fx::Node";
    fn paneweft_type_id(&self) -> &'static str {
        self.type_id
    }
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        cx.label(&self.label);
        for (name, value) in &self.fields {
            cx.field(name, value.clone());
        }
        let mut details = cx.details();
        details.field("label", self.label.as_str());
        let mut set = ViewSetResult::new();
        let links: Vec<(String, Rc<Node>)> = self.links.borrow().clone();
        for (name, child) in links {
            let outcome = cx.reference_full(&name, child.key.as_deref(), &*child);
            if let Err(error) = outcome {
                set.push(NODE_VIEW, Err(error));
                return set;
            }
        }
        set.push(NODE_VIEW, details.finish());
        set
    }
}

pub fn build_nodes(scenario: &Json) -> BTreeMap<String, Rc<Node>> {
    let mut nodes = BTreeMap::new();
    for (name, spec) in scenario["nodes"].as_object().unwrap() {
        let type_id: &'static str = Box::leak(spec["type"].as_str().unwrap().to_string().into_boxed_str());
        let fields = spec["fields"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), value_from_spec(v))).collect();
        nodes.insert(name.clone(), Rc::new(Node { type_id, key: spec["key"].as_str().map(|k| k.to_string()), label: spec["label"].as_str().unwrap().to_string(), fields, links: RefCell::new(Vec::new()) }));
    }
    for (name, spec) in scenario["nodes"].as_object().unwrap() {
        for link in spec["links"].as_array().unwrap() {
            let target = nodes[link["to"].as_str().unwrap()].clone();
            nodes[name].links.borrow_mut().push((link["name"].as_str().unwrap().to_string(), target));
        }
    }
    nodes
}

/// Runs a scenario through the Rust SDK and returns the `paneweft.object-graph/1` document as JSON.
pub fn run_scenario(scenario: &Json) -> Json {
    let nodes = build_nodes(scenario);
    let options = CaptureOptions { limits: limits_from(&scenario["limits"]), ..CaptureOptions::default() };
    let mut capture = Capture::new(options);
    for publish in scenario["publish"].as_array().unwrap() {
        match publish {
            Json::String(name) => {
                must(capture.publish(&*nodes[name.as_str()]), "publish");
            }
            other => {
                let node = &nodes[other["node"].as_str().unwrap()];
                must(capture.publish_with_identity(&**node, other["identity"].as_str().unwrap()), "publish_with_identity");
            }
        }
    }
    capture.finish().to_json()
}

/// The expected objects of a scenario fixture without the reviewer-only `hashInput`.
pub fn expected_objects(scenario: &Json) -> Json {
    let mut objects = scenario["expected"]["objects"].clone();
    for object in objects.as_array_mut().unwrap() {
        object.as_object_mut().unwrap().remove("hashInput");
    }
    objects
}

// ---- the WatchFile fixture -----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchStatus {
    Pending,
    Cancelled,
}

/// Deliberately NOT `Serialize` and holding a field (`summary`) that can contain log content.
pub struct Event {
    pub event_id: String,
    pub tick: u64,
    pub redelivered: bool,
    pub summary: String,
}

pub struct WatchFile {
    pub status: WatchStatus,
    pub tick: u64,
    pub judge_status: &'static str,
    pub events: Vec<Event>,
}

pub fn event(event_id: &str, tick: u64, redelivered: bool) -> Event {
    Event { event_id: event_id.to_string(), tick, redelivered, summary: "SECRET LOG LINE".to_string() }
}

impl WatchFile {
    pub fn pending() -> WatchFile {
        WatchFile { status: WatchStatus::Pending, tick: 0, judge_status: "Idle", events: Vec::new() }
    }
    pub fn with_events(events: Vec<Event>) -> WatchFile {
        WatchFile { status: WatchStatus::Cancelled, tick: 7, judge_status: "Idle", events }
    }
}

/// Hand-written (manual) implementation: only event_id, tick and redelivered; `summary` is omitted on purpose.
impl Inspectable for Event {
    const PANEWEFT_TYPE_ID: &'static str = "fixture::watch::Event";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        const META: ViewMeta = ViewMeta { id: "event.details", title: "Event", question: "Which event is this, and was it redelivered?", component: "shape", priority: 10 };
        cx.label(&self.event_id);
        // Object hashes include captured fields; redeliveries with different ticks must remain distinguishable.
        cx.field("tick", self.tick);
        cx.field("redelivered", self.redelivered);
        let mut details = cx.details();
        details.field("event_id", self.event_id.as_str());
        details.field("tick", self.tick);
        details.field("redelivered", self.redelivered);
        let mut set = ViewSetResult::new();
        set.push(META, details.finish());
        set
    }
}

#[paneweft::views(type_id = "fixture::watch::WatchFile")]
impl WatchFile {
    #[paneweft::view(id = "watch.status", title = "Status", component = "shape", priority = 10, question = "What state did this watch reach?")]
    fn status_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
        let mut details = cx.details();
        details.field("status", format!("{:?}", self.status));
        details.field("tick", self.tick);
        details.field("judge status", self.judge_status);
        details.field("event count", self.events.len());
        details.finish()
    }

    #[paneweft::view(id = "watch.events", title = "Events", component = "list", priority = 20, question = "Which events were retained, and were they redelivered?")]
    fn events_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
        let mut table = cx.table().text_column("event", "Event").number_column("tick", "Tick").boolean_column("redelivered", "Redelivered").order_by("event", paneweft::Ascending);
        for (index, event) in self.events.iter().enumerate() {
            let target = cx.reference_keyed(event, &event.event_id)?;
            table.row(paneweft::Row::new(format!("event-{index}")).cell("event", event.event_id.as_str()).cell("tick", event.tick).cell("redelivered", event.redelivered).target(target));
        }
        table.finish()
    }
}

pub fn capture_watch(watch: &WatchFile, limits: Limits) -> Json {
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    must(capture.publish(watch), "publish watch");
    capture.finish().to_json()
}

pub fn default_limits() -> Limits {
    limits_from(&Json::Null)
}
