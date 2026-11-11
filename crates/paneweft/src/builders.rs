//! Context-owned, bounded view builders (spec amendment S5). A builder stops accepting rows at its limit and reports the omission;
//! exhaustion yields partial output with retained rows and an omission count, never a failed view.
//! Lowering follows docs/v1-red-contract.md section 3: `details()` becomes a shape, `table()` becomes a list.
use crate::capture::{ObjectRef, ViewError, ViewResult};
use crate::json::{canonical, sha256_hex};
use crate::limits::Limits;
use crate::value::{EncodeStats, Value};
use serde_json::{json, Map, Value as Json};
use std::cell::Cell;
use std::collections::{BTreeMap, HashSet};
use std::rc::Rc;
use std::time::Instant;

/// Returned by every builder insertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bounded {
    /// The item was kept.
    Accepted,
    /// The item was refused because the builder is full; `omitted_so_far` counts refused items including this one.
    Full { omitted_so_far: u64 },
}

/// One stored page beyond the first (content addressed by the capture, which knows the owning view and object).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BuiltPage {
    pub page_id: String,
    pub rows: Vec<Json>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Built {
    /// `shape` or `list`.
    pub component: &'static str,
    /// The v0 component data of the first page.
    pub data: Json,
    pub pages: Vec<BuiltPage>,
    /// Rows retained over all pages (lists only).
    pub rows_total: Option<u64>,
    /// Omissions by name (`rows`, `strings`), as counts.
    pub omitted: BTreeMap<String, u64>,
    /// Milliseconds the view's own computation took when it exceeded the cooperative budget.
    pub over_budget_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ViewBody {
    Built(Built),
    Unsupported(String),
}

/// A built view: component, normalized v0 component data, completeness. Opaque to authors.
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub(crate) body: ViewBody,
}

impl View {
    /// An explicit unsupported result with a reason (a view that does not apply is not an error).
    pub fn unsupported(reason: &str) -> View {
        View { body: ViewBody::Unsupported(reason.to_string()) }
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

/// The part of a builder that measures the view's own computation: wall time minus the time spent publishing children.
#[derive(Clone)]
pub(crate) struct Budget {
    started: Instant,
    nested_at_start: u128,
    nested: Rc<Cell<u128>>,
    limit_ms: u64,
}

impl Budget {
    pub(crate) fn start(nested: Rc<Cell<u128>>, limit_ms: u64) -> Budget {
        Budget { started: Instant::now(), nested_at_start: nested.get(), nested, limit_ms }
    }

    fn over(&self) -> Option<u64> {
        let total = self.started.elapsed().as_nanos();
        let own = total.saturating_sub(self.nested.get().saturating_sub(self.nested_at_start));
        let millis = (own / 1_000_000) as u64;
        (millis > self.limit_ms).then_some(millis)
    }
}

fn output_schema(message: String) -> ViewError {
    ViewError { category: "output-schema".to_string(), message }
}

fn valid_id(kind: &str, text: &str) -> Result<(), ViewError> {
    if text.is_empty() || text.chars().count() > 120 {
        return Err(output_schema(format!("{kind} {text:?} must be 1 to 120 characters")));
    }
    Ok(())
}

fn evidence() -> Json {
    json!(["run"])
}

/// `cx.details()`: lowers into the existing shape component.
pub struct DetailsBuilder {
    pub(crate) fields: Vec<(String, Value)>,
    pub(crate) limits: Limits,
    pub(crate) omitted: u64,
    pub(crate) budget: Budget,
}

impl DetailsBuilder {
    pub(crate) fn new(limits: Limits, budget: Budget) -> DetailsBuilder {
        DetailsBuilder { fields: Vec::new(), limits, omitted: 0, budget }
    }

    /// Adds one named leaf. A full builder refuses the field and counts it.
    pub fn field(&mut self, name: &str, value: impl Into<Value>) -> Bounded {
        if self.fields.len() as u64 >= u64::from(self.limits.view_rows) {
            self.omitted += 1;
            return Bounded::Full { omitted_so_far: self.omitted };
        }
        self.fields.push((name.to_string(), value.into()));
        Bounded::Accepted
    }

    pub fn finish(self) -> ViewResult {
        let mut stats = EncodeStats::default();
        let mut seen = HashSet::new();
        let mut children = Vec::new();
        let mut leaves = Vec::new();
        for (name, value) in &self.fields {
            valid_id("field name", name)?;
            if !seen.insert(name.as_str()) {
                return Err(output_schema(format!("duplicate field name {name:?}: field names are the leaf ids of one shape")));
            }
            let id = format!("details.{name}");
            let mut leaf = Map::new();
            leaf.insert("id".into(), json!(id));
            leaf.insert("path".into(), json!(format!("$.{name}")));
            leaf.insert("type".into(), json!(value.type_name()));
            leaf.insert("presence".into(), json!("required"));
            leaf.insert("example".into(), value.scalar(&self.limits, &mut stats));
            leaf.insert("children".into(), json!([]));
            leaf.insert("provenance".into(), json!("observed"));
            leaf.insert("evidence".into(), evidence());
            children.push(json!(id));
            leaves.push(Json::Object(leaf));
        }
        let mut fields = vec![json!({"id": "details", "path": "$", "type": "object", "presence": "required", "children": children, "provenance": "observed", "evidence": evidence()})];
        fields.extend(leaves);
        let mut omitted = BTreeMap::new();
        if self.omitted > 0 {
            omitted.insert("rows".to_string(), self.omitted);
        }
        if stats.strings > 0 {
            omitted.insert("strings".to_string(), stats.strings);
        }
        Ok(View { body: ViewBody::Built(Built { component: "shape", data: json!({"basis": "observed", "root": "details", "fields": fields}), pages: Vec::new(), rows_total: None, omitted, over_budget_ms: self.budget.over() }) })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction { Ascending, Descending }
pub use Direction::{Ascending, Descending};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format { Text, Number, Boolean }

impl Format {
    fn name(self) -> &'static str {
        match self { Format::Text => "text", Format::Number => "number", Format::Boolean => "boolean" }
    }
}

/// `cx.table()`: lowers into the existing list component.
pub struct TableBuilder {
    pub(crate) rows: Vec<Row>,
    columns: Vec<(String, String, Format)>,
    order: Option<(String, Direction)>,
    limits: Limits,
    omitted: u64,
    budget: Budget,
}

impl TableBuilder {
    pub(crate) fn new(limits: Limits, budget: Budget) -> TableBuilder {
        TableBuilder { rows: Vec::new(), columns: Vec::new(), order: None, limits, omitted: 0, budget }
    }

    fn column(mut self, key: &str, title: &str, format: Format) -> TableBuilder {
        self.columns.push((key.to_string(), title.to_string(), format));
        self
    }

    pub fn text_column(self, key: &str, title: &str) -> TableBuilder { self.column(key, title, Format::Text) }
    pub fn number_column(self, key: &str, title: &str) -> TableBuilder { self.column(key, title, Format::Number) }
    pub fn boolean_column(self, key: &str, title: &str) -> TableBuilder { self.column(key, title, Format::Boolean) }

    /// Records the order and sorts rows by that column, stable (equal keys keep insertion order).
    pub fn order_by(mut self, key: &str, direction: Direction) -> TableBuilder {
        self.order = Some((key.to_string(), direction));
        self
    }

    pub fn row(&mut self, row: Row) -> Bounded {
        if self.rows.len() as u64 >= u64::from(self.limits.view_rows) {
            self.omitted += 1;
            return Bounded::Full { omitted_so_far: self.omitted };
        }
        self.rows.push(row);
        Bounded::Accepted
    }

    pub fn finish(self) -> ViewResult {
        if self.columns.is_empty() {
            return Err(output_schema("a table needs at least one column: call text_column, number_column or boolean_column".to_string()));
        }
        let mut column_keys = HashSet::new();
        for (key, title, _) in &self.columns {
            valid_id("column key", key)?;
            if title.is_empty() {
                return Err(output_schema(format!("column {key:?} needs a title")));
            }
            if !column_keys.insert(key.as_str()) {
                return Err(output_schema(format!("duplicate column key {key:?}")));
            }
        }
        // Without order_by the table is ordered by its first column ascending, and says so: the recorded order is always true.
        let (order_key, direction) = match &self.order {
            Some((key, direction)) => (key.clone(), *direction),
            None => (self.columns[0].0.clone(), Direction::Ascending),
        };
        if !column_keys.contains(order_key.as_str()) {
            return Err(output_schema(format!("order_by names {order_key:?}, which is not a declared column")));
        }
        let mut stats = EncodeStats::default();
        let mut row_ids = HashSet::new();
        let mut rendered: Vec<(Json, Json)> = Vec::new();
        for row in &self.rows {
            valid_id("row id", &row.id)?;
            if !row_ids.insert(row.id.as_str()) {
                return Err(output_schema(format!("duplicate row id {:?}: row ids are occurrence ids and must be unique", row.id)));
            }
            let mut cells = Map::new();
            for (key, value) in &row.cells {
                if !column_keys.contains(key.as_str()) {
                    return Err(output_schema(format!("row {:?} has a cell {key:?} that no column declares", row.id)));
                }
                cells.insert(key.clone(), value.scalar(&self.limits, &mut stats));
            }
            let sort_key = cells.get(&order_key).cloned().unwrap_or(Json::Null);
            let mut entry = Map::new();
            entry.insert("id".into(), json!(row.id));
            entry.insert("cells".into(), Json::Object(cells));
            entry.insert("provenance".into(), json!("observed"));
            entry.insert("evidence".into(), evidence());
            if let Some(target) = &row.target {
                entry.insert("target".into(), target.to_json());
            }
            rendered.push((sort_key, Json::Object(entry)));
        }
        rendered.sort_by(|(left, _), (right, _)| {
            let ordering = compare_cells(left, right);
            if direction == Direction::Descending { ordering.reverse() } else { ordering }
        });
        let rows: Vec<Json> = rendered.into_iter().map(|(_, row)| row).collect();
        let total = rows.len() as u64;
        let page_rows = self.limits.page_rows.max(1) as usize;
        let mut chunks = rows.chunks(page_rows);
        let first: Vec<Json> = chunks.next().map(<[Json]>::to_vec).unwrap_or_default();
        let pages: Vec<BuiltPage> = chunks.map(|chunk| BuiltPage { page_id: format!("sha256:{}", sha256_hex(&canonical(&Json::Array(chunk.to_vec())))), rows: chunk.to_vec() }).collect();
        let columns: Vec<Json> = self.columns.iter().map(|(key, title, format)| json!({"key": key, "title": title, "format": format.name()})).collect();
        let mut omitted = BTreeMap::new();
        if self.omitted > 0 {
            omitted.insert("rows".to_string(), self.omitted);
        }
        if stats.strings > 0 {
            omitted.insert("strings".to_string(), stats.strings);
        }
        let order = json!({"key": order_key, "direction": if direction == Direction::Ascending { "asc" } else { "desc" }});
        Ok(View { body: ViewBody::Built(Built { component: "list", data: json!({"columns": columns, "rows": first, "order": order}), pages, rows_total: Some(total), omitted, over_budget_ms: self.budget.over() }) })
    }
}

/// Null < boolean < number < string; numbers numerically, strings by code point. A total order, so the sort is deterministic.
fn compare_cells(left: &Json, right: &Json) -> std::cmp::Ordering {
    fn rank(value: &Json) -> u8 {
        match value { Json::Null => 0, Json::Bool(_) => 1, Json::Number(_) => 2, _ => 3 }
    }
    match (left, right) {
        (Json::Bool(a), Json::Bool(b)) => a.cmp(b),
        (Json::Number(a), Json::Number(b)) => a.as_f64().partial_cmp(&b.as_f64()).unwrap_or(std::cmp::Ordering::Equal),
        (Json::String(a), Json::String(b)) => a.cmp(b),
        _ => rank(left).cmp(&rank(right)),
    }
}
