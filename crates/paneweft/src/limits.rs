//! Collection bounds (spec section 4). Defaults are the numbers in the spec; owner configuration may lower them.
//! `view_rows` is the one number the spec does not give: it bounds the rows (or fields) of one view and defaults to v0's
//! `factItemsPerView` (docs/v1-red-contract.md section 5).
use serde_json::json;

/// Hard limits applied while building, never after constructing an unbounded intermediate value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub depth: u32,
    pub objects: u32,
    pub references: u32,
    pub root_bytes: u64,
    pub string_bytes: u64,
    pub page_rows: u32,
    pub collection_bytes: u64,
    pub roots: u32,
    pub view_rows: u32,
    pub view_budget_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            depth: 4,
            objects: 1000,
            references: 4000,
            root_bytes: 2 * 1024 * 1024,
            string_bytes: 16 * 1024,
            page_rows: 100,
            collection_bytes: 32 * 1024 * 1024,
            roots: 100,
            view_rows: 10_000,
            view_budget_ms: 100,
        }
    }
}

impl Limits {
    /// The `limits` member of `paneweft.object-graph/1`.
    pub fn to_json(&self) -> serde_json::Value {
        json!({
            "depth": self.depth,
            "objects": self.objects,
            "references": self.references,
            "rootBytes": self.root_bytes,
            "stringBytes": self.string_bytes,
            "pageRows": self.page_rows,
            "collectionBytes": self.collection_bytes,
            "roots": self.roots,
            "viewRows": self.view_rows,
            "viewBudgetMs": self.view_budget_ms,
        })
    }

    /// The smallest value each bound can take (the object-graph schema's `minimum`).
    const MINIMUMS: Limits = Limits { depth: 0, objects: 1, references: 0, root_bytes: 1, string_bytes: 1, page_rows: 1, collection_bytes: 1, roots: 1, view_rows: 1, view_budget_ms: 1 };

    /// Applies overrides (the camelCase names of the wire `LimitOverrides`). An override can only LOWER a bound (S3): a value is taken when
    /// it is a non-negative integer, raised to the schema minimum, and clamped to `self` and to `ceiling`, so a payload that asks for more
    /// than the operator allows gets the operator's number. Unknown names, non-integers and negatives are ignored; an integer that does not
    /// fit the bound's type is a request for more than any ceiling and is clamped, never narrowed.
    pub fn with_overrides_under(mut self, overrides: &serde_json::Value, ceiling: &Limits) -> Limits {
        let Some(map) = overrides.as_object() else { return self };
        let narrow = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
        let (base, min) = (self, Limits::MINIMUMS);
        for (key, value) in map {
            let Some(n) = value.as_u64() else { continue };
            match key.as_str() {
                "depth" => self.depth = narrow(n).max(min.depth).min(ceiling.depth).min(base.depth),
                "objects" => self.objects = narrow(n).max(min.objects).min(ceiling.objects).min(base.objects),
                "references" => self.references = narrow(n).max(min.references).min(ceiling.references).min(base.references),
                "rootBytes" => self.root_bytes = n.max(min.root_bytes).min(ceiling.root_bytes).min(base.root_bytes),
                "stringBytes" => self.string_bytes = n.max(min.string_bytes).min(ceiling.string_bytes).min(base.string_bytes),
                "pageRows" => self.page_rows = narrow(n).max(min.page_rows).min(ceiling.page_rows).min(base.page_rows),
                "collectionBytes" => self.collection_bytes = n.max(min.collection_bytes).min(ceiling.collection_bytes).min(base.collection_bytes),
                "roots" => self.roots = narrow(n).max(min.roots).min(ceiling.roots).min(base.roots),
                "viewRows" => self.view_rows = narrow(n).max(min.view_rows).min(ceiling.view_rows).min(base.view_rows),
                "viewBudgetMs" => self.view_budget_ms = n.max(min.view_budget_ms).min(ceiling.view_budget_ms).min(base.view_budget_ms),
                _ => {}
            }
        }
        self
    }

    /// Applies overrides under the ceiling of the numbers `self` already holds (the operator's).
    pub fn with_overrides(self, overrides: &serde_json::Value) -> Limits {
        let ceiling = self;
        self.with_overrides_under(overrides, &ceiling)
    }
}
