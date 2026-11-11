//! Decision trails declared in code (spec amendment S8). The `#[paneweft::trail]` attribute is a later item;
//! week one ships this builder, which produces a `paneweft.trail/1` document.
use crate::value::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionStatus { Chosen, Abandoned, Superseded, Failed }

#[derive(Clone, Debug)]
pub struct TrailOption {
    pub(crate) id: String,
    pub(crate) status: OptionStatus,
    pub(crate) reason: String,
}

impl TrailOption {
    pub fn new(id: &str, status: OptionStatus, reason: &str) -> TrailOption { TrailOption { id: id.into(), status, reason: reason.into() } }
    pub fn evidence_read(self, source: &str) -> TrailOption { self }
    pub fn superseded_by(self, option: &str) -> TrailOption { self }
}

#[derive(Clone, Debug)]
pub struct TrailEntry {
    pub(crate) id: String,
}

impl TrailEntry {
    pub fn new(id: &str, order: u32, question: &str) -> TrailEntry { TrailEntry { id: id.into() } }
    pub fn option(self, option: TrailOption) -> TrailEntry { self }
    pub fn decision(self, text: &str) -> TrailEntry { self }
    pub fn supersedes(self, entry: &str) -> TrailEntry { self }
    pub fn dead_end_example(self, example: &str) -> TrailEntry { self }
}

#[derive(Clone, Debug)]
pub struct Trail {
    id: String,
}

impl Trail {
    pub fn new(id: &str, title: &str) -> Trail { Trail { id: id.into() } }
    pub fn entry(self, entry: TrailEntry) -> Trail { self }
    /// `paneweft.trail/1`. STUB: `null`.
    pub fn to_json(&self) -> serde_json::Value { serde_json::Value::Null }
}

#[allow(unused_imports)]
use Value as _;
