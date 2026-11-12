//! Registration, catalogue and the explicit-slice fallback (spec section 2, decision 3).
//!
//! Native descriptors register through linkme distributed slices (no runtime initialization, no ordering guarantee), so every
//! catalogue is SORTED by id and byte-identical whatever the link order. A duplicate id is an error that names both sources.
//! Where linker sections are unavailable, [`Catalogue::from_descriptors`] builds the same catalogue from explicit slices.
use linkme::distributed_slice;
use serde_json::{json, Value as Json};

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
    /// The libtest path of the generated wrapper test, written by the `example` attribute as `<crate>::<module path>::paneweft_example_<fn>`;
    /// the catalogue strips the leading crate segment, because libtest paths do not carry it.
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
}

impl std::fmt::Display for CatalogueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CatalogueError::DuplicateId { id, kind, sources } => {
                let places: Vec<String> = sources.iter().map(|(file, line)| format!("{file}:{line}")).collect();
                write!(f, "duplicate {kind} id {id:?} declared at {}", places.join(" and "))
            }
        }
    }
}

impl std::error::Error for CatalogueError {}

/// The compiled catalogue: sorted by id, independent of registration order.
#[derive(Clone, Debug, PartialEq)]
pub struct Catalogue {
    json: Json,
}

/// `crate::a::b::paneweft_example_x` -> `a::b::paneweft_example_x`, the path libtest filters on.
pub(crate) fn libtest_path(test_name: &str) -> &str {
    test_name.split_once("::").map_or(test_name, |(_, rest)| rest)
}

/// `crate::a::b` -> `a::b`; the crate root module is named after the crate.
fn module_name(module: &str) -> String {
    module.split_once("::").map_or(module, |(_, rest)| rest).to_string()
}

fn view_json(view: &ViewDescriptor) -> Json {
    json!({
        "id": view.id,
        "typeId": view.type_id,
        "title": view.title,
        "question": view.question,
        "component": view.component,
        "priority": view.priority,
        "source": {"path": view.source.file, "line": view.source.line},
        "module": module_name(view.module),
    })
}

fn example_json(example: &ExampleDescriptor) -> Json {
    json!({
        "id": example.id,
        "typeId": example.type_id,
        "claims": example.claims,
        "kind": if example.kind == ExampleKind::DeadEnd { "dead-end" } else { "example" },
        "composes": [],
        "source": {"path": example.source.file, "line": example.source.line},
        "module": module_name(example.module),
        "selector": {"runner": "cargo", "name": libtest_path(example.test_name)},
    })
}

/// One entry per type id: the first declaration (by path then line) supplies the source path; the symbol is the last path segment.
fn types_json(views: &[ViewDescriptor], examples: &[ExampleDescriptor]) -> Vec<Json> {
    let mut by_type: std::collections::BTreeMap<&str, (&str, u32)> = std::collections::BTreeMap::new();
    let mut note = |type_id: &'static str, location: SourceLocation| {
        let candidate = (location.file, location.line);
        by_type.entry(type_id).and_modify(|current| if candidate < *current { *current = candidate }).or_insert(candidate);
    };
    for view in views {
        note(view.type_id, view.source);
    }
    for example in examples {
        note(example.type_id, example.source);
    }
    by_type
        .into_iter()
        .map(|(type_id, (path, _))| json!({"typeId": type_id, "source": {"path": path, "symbol": type_id.rsplit("::").next().unwrap_or(type_id)}}))
        .collect()
}

fn sorted<T: Copy>(items: &[T], key: impl Fn(&T) -> (&'static str, &'static str, u32)) -> Vec<T> {
    let mut copy = items.to_vec();
    copy.sort_by_key(|item| key(item));
    copy
}

impl Catalogue {
    /// Everything linked into this binary through linkme.
    pub fn linked() -> Result<Catalogue, CatalogueError> {
        Catalogue::from_descriptors(&VIEW_DESCRIPTORS, &EXAMPLE_DESCRIPTORS)
    }

    /// The explicit-slice fallback for a target without linker sections.
    pub fn from_descriptors(views: &[ViewDescriptor], examples: &[ExampleDescriptor]) -> Result<Catalogue, CatalogueError> {
        let views = sorted(views, |v| (v.id, v.source.file, v.source.line));
        let examples = sorted(examples, |e| (e.id, e.source.file, e.source.line));
        check_duplicates("view", views.iter().map(|v| (v.id, v.source)))?;
        check_duplicates("example", examples.iter().map(|e| (e.id, e.source)))?;
        Ok(Catalogue::assemble(&views, &examples))
    }

    fn assemble(views: &[ViewDescriptor], examples: &[ExampleDescriptor]) -> Catalogue {
        Catalogue { json: json!({"types": types_json(views, examples), "views": views.iter().map(view_json).collect::<Vec<_>>(), "examples": examples.iter().map(example_json).collect::<Vec<_>>()}) }
    }

    /// `paneweft.catalogue/1` content (types, views, examples) without target and linked scope, which the adapter adds.
    pub fn to_json(&self) -> Json { self.json.clone() }

    /// The worker artifact of the catalogue export: everything linked, DUPLICATES INCLUDED, so the host merge reports both sources
    /// of a repeated id instead of this binary hiding one of them.
    pub fn linked_part(source: &str) -> Json {
        let views = sorted(&VIEW_DESCRIPTORS, |v| (v.id, v.source.file, v.source.line));
        let examples = sorted(&EXAMPLE_DESCRIPTORS, |e| (e.id, e.source.file, e.source.line));
        let mut part = Catalogue::assemble(&views, &examples).json;
        part["schemaVersion"] = json!("paneweft.catalogue-part/1");
        part["source"] = json!(source);
        part
    }
}

fn check_duplicates(kind: &'static str, items: impl Iterator<Item = (&'static str, SourceLocation)>) -> Result<(), CatalogueError> {
    let mut previous: Option<(&'static str, SourceLocation)> = None;
    for (id, source) in items {
        if let Some((previous_id, previous_source)) = previous {
            if previous_id == id {
                return Err(CatalogueError::DuplicateId { id: id.to_string(), kind, sources: vec![(previous_source.file.to_string(), previous_source.line), (source.file.to_string(), source.line)] });
            }
        }
        previous = Some((id, source));
    }
    Ok(())
}
