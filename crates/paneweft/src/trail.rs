//! Decision trails declared in code (spec amendment S8). The `#[paneweft::trail]` attribute is a later item;
//! week one ships this builder, which produces a `paneweft.trail/1` document.
use serde_json::{json, Map, Value as Json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionStatus { Chosen, Abandoned, Superseded, Failed }

impl OptionStatus {
    fn name(self) -> &'static str {
        match self {
            OptionStatus::Chosen => "chosen",
            OptionStatus::Abandoned => "abandoned",
            OptionStatus::Superseded => "superseded",
            OptionStatus::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrailOption {
    pub(crate) id: String,
    pub(crate) status: OptionStatus,
    pub(crate) reason: String,
    evidence: Vec<Json>,
    superseded_by: Option<String>,
}

impl TrailOption {
    pub fn new(id: &str, status: OptionStatus, reason: &str) -> TrailOption {
        TrailOption { id: id.into(), status, reason: reason.into(), evidence: Vec::new(), superseded_by: None }
    }
    /// Evidence the author read (provenance `read`); the host maps `source` to a source id of the lowered view.
    pub fn evidence_read(mut self, source: &str) -> TrailOption {
        self.evidence.push(json!({"provenance": "read", "source": source}));
        self
    }
    pub fn superseded_by(mut self, option: &str) -> TrailOption {
        self.superseded_by = Some(option.to_string());
        self
    }
    fn to_json(&self) -> Json {
        let mut option = Map::new();
        option.insert("id".into(), json!(self.id));
        option.insert("status".into(), json!(self.status.name()));
        option.insert("reason".into(), json!(self.reason));
        option.insert("evidence".into(), Json::Array(self.evidence.clone()));
        if let Some(by) = &self.superseded_by {
            option.insert("supersededBy".into(), json!(by));
        }
        Json::Object(option)
    }
}

#[derive(Clone, Debug)]
pub struct TrailEntry {
    pub(crate) id: String,
    order: u32,
    question: String,
    options: Vec<TrailOption>,
    decision: String,
    supersedes: Option<String>,
    dead_end_example: Option<String>,
}

impl TrailEntry {
    pub fn new(id: &str, order: u32, question: &str) -> TrailEntry {
        TrailEntry { id: id.into(), order, question: question.into(), options: Vec::new(), decision: String::new(), supersedes: None, dead_end_example: None }
    }
    pub fn option(mut self, option: TrailOption) -> TrailEntry { self.options.push(option); self }
    pub fn decision(mut self, text: &str) -> TrailEntry { self.decision = text.into(); self }
    /// Supersession is explicit by entry id, never inferred from order.
    pub fn supersedes(mut self, entry: &str) -> TrailEntry { self.supersedes = Some(entry.into()); self }
    /// Links the entry to the runnable example that reproduces its failure (an expected-failure example, spec N4).
    pub fn dead_end_example(mut self, example: &str) -> TrailEntry { self.dead_end_example = Some(example.into()); self }
    fn to_json(&self) -> Json {
        let mut entry = Map::new();
        entry.insert("id".into(), json!(self.id));
        entry.insert("order".into(), json!(self.order));
        entry.insert("question".into(), json!(self.question));
        entry.insert("options".into(), Json::Array(self.options.iter().map(TrailOption::to_json).collect()));
        entry.insert("decision".into(), json!(self.decision));
        entry.insert("links".into(), json!([]));
        if let Some(by) = &self.supersedes {
            entry.insert("supersedes".into(), json!(by));
        }
        if let Some(example) = &self.dead_end_example {
            entry.insert("deadEndExample".into(), json!(example));
        }
        Json::Object(entry)
    }
}

#[derive(Clone, Debug)]
pub struct Trail {
    id: String,
    title: String,
    entries: Vec<TrailEntry>,
}

impl Trail {
    pub fn new(id: &str, title: &str) -> Trail { Trail { id: id.into(), title: title.into(), entries: Vec::new() } }
    pub fn entry(mut self, entry: TrailEntry) -> Trail { self.entries.push(entry); self }
    /// `paneweft.trail/1`.
    pub fn to_json(&self) -> Json {
        json!({"schemaVersion": "paneweft.trail/1", "id": self.id, "title": self.title, "entries": self.entries.iter().map(TrailEntry::to_json).collect::<Vec<_>>()})
    }
}
