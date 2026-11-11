//! Registration, catalogue and the explicit-slice fallback (spec section 2, decision 3).
use linkme::distributed_slice;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceLocation {
    pub file: &'static str,
    pub line: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewDescriptor {
    pub id: &'static str,
    pub type_id: &'static str,
    pub title: &'static str,
    pub question: &'static str,
    pub component: &'static str,
    pub priority: i32,
    pub module: &'static str,
    pub source: SourceLocation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExampleKind { Example, DeadEnd }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExampleDescriptor {
    pub id: &'static str,
    pub type_id: &'static str,
    pub claims: &'static [&'static str],
    pub module: &'static str,
    pub source: SourceLocation,
    /// The exact libtest path of the generated wrapper, e.g. `paneweft_examples::watch_cancelled`.
    pub test_name: &'static str,
    pub kind: ExampleKind,
}

/// Native Rust descriptors register here (linkme distributed slices, no runtime initialization).
#[distributed_slice]
pub static VIEW_DESCRIPTORS: [ViewDescriptor] = [..];
#[distributed_slice]
pub static EXAMPLE_DESCRIPTORS: [ExampleDescriptor] = [..];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogueError {
    /// Two declarations share an id: both sources are reported.
    DuplicateId { id: String, kind: &'static str, sources: Vec<(String, u32)> },
    NotImplemented,
}

/// The compiled catalogue: sorted by id, independent of registration order.
#[derive(Clone, Debug, PartialEq)]
pub struct Catalogue {
    json: serde_json::Value,
}

impl Catalogue {
    /// Everything linked into this binary through linkme. STUB: `Err(NotImplemented)`.
    pub fn linked() -> Result<Catalogue, CatalogueError> { Err(CatalogueError::NotImplemented) }
    /// The explicit-slice fallback for a target without linker sections. STUB: `Err(NotImplemented)`.
    pub fn from_descriptors(views: &[ViewDescriptor], examples: &[ExampleDescriptor]) -> Result<Catalogue, CatalogueError> {
        Err(CatalogueError::NotImplemented)
    }
    /// `paneweft.catalogue/1` (without target and linked scope, which the adapter adds).
    pub fn to_json(&self) -> serde_json::Value { self.json.clone() }
}
