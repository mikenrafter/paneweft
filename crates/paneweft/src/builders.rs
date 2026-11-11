//! Context-owned, bounded view builders (spec amendment S5). A builder stops accepting rows at its limit and reports the omission;
//! exhaustion yields partial output with retained rows and an omission count, never a failed view.
use crate::capture::{ObjectRef, ViewError, ViewResult};
use crate::value::Value;

/// Returned by every builder insertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bounded {
    /// The item was kept.
    Accepted,
    /// The item was refused because the builder is full; `omitted_so_far` counts refused items including this one.
    Full { omitted_so_far: u64 },
}

/// A built view: component, normalized v0 component data, completeness. Opaque to authors.
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub(crate) component: String,
    pub(crate) data: serde_json::Value,
}

impl View {
    /// An explicit unsupported result with a reason (a view that does not apply is not an error).
    pub fn unsupported(reason: &str) -> View {
        View { component: String::new(), data: serde_json::Value::Null }
    }
}

/// One list row. The id is an OCCURRENCE id, not the domain id: two rows may show the same domain id.
#[derive(Clone, Debug)]
pub struct Row {
    pub(crate) id: String,
    pub(crate) cells: Vec<(String, Value)>,
    pub(crate) target: Option<ObjectRef>,
}

impl Row {
    pub fn new(id: impl Into<String>) -> Row { Row { id: id.into(), cells: Vec::new(), target: None } }
    pub fn cell(mut self, key: &str, value: impl Into<Value>) -> Row { self.cells.push((key.to_string(), value.into())); self }
    pub fn target(mut self, target: ObjectRef) -> Row { self.target = Some(target); self }
}

/// `cx.details()`: lowers into the existing shape component.
pub struct DetailsBuilder {
    pub(crate) fields: Vec<(String, Value)>,
}

impl DetailsBuilder {
    pub fn field(&mut self, name: &str, value: impl Into<Value>) -> Bounded { Bounded::Accepted }
    pub fn finish(self) -> ViewResult { Err(ViewError::not_implemented("DetailsBuilder::finish")) }
}

/// `cx.table()`: lowers into the existing list component.
pub struct TableBuilder {
    pub(crate) rows: Vec<Row>,
}

impl TableBuilder {
    pub fn text_column(self, key: &str, title: &str) -> TableBuilder { self }
    pub fn number_column(self, key: &str, title: &str) -> TableBuilder { self }
    pub fn boolean_column(self, key: &str, title: &str) -> TableBuilder { self }
    /// Records the order and sorts rows by that column, stable (equal keys keep insertion order).
    pub fn order_by(self, key: &str, direction: Direction) -> TableBuilder { self }
    pub fn row(&mut self, row: Row) -> Bounded { Bounded::Accepted }
    pub fn finish(self) -> ViewResult { Err(ViewError::not_implemented("TableBuilder::finish")) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction { Ascending, Descending }
pub use Direction::{Ascending, Descending};
