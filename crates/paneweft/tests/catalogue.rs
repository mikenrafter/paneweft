//! Registration (IV3): linkme across separately linked modules, the explicit-slice fallback, sorting and duplicate reports.
mod support;
use linkme::distributed_slice;
use paneweft::catalogue::{EXAMPLE_DESCRIPTORS, VIEW_DESCRIPTORS};
use paneweft::{Catalogue, CatalogueError, ExampleDescriptor, ExampleKind, SourceLocation, ViewDescriptor};
use serde_json::json;

paneweft::test_adapter!();

const fn view(id: &'static str, module: &'static str, line: u32) -> ViewDescriptor {
    ViewDescriptor { id, type_id: "fx::T", title: "T", question: "Q?", component: "shape", priority: 10, module, source: SourceLocation { file: "src/lib.rs", line } }
}

// two separately linked modules, each registering one view through the real linkme slice
mod module_b {
    use super::*;
    #[distributed_slice(VIEW_DESCRIPTORS)]
    #[linkme(crate = paneweft::linkme)]
    static B_VIEW: ViewDescriptor = view("b.view", "module_b", 10);
}
mod module_a {
    use super::*;
    #[distributed_slice(VIEW_DESCRIPTORS)]
    #[linkme(crate = paneweft::linkme)]
    static A_VIEW: ViewDescriptor = view("a.view", "module_a", 20);
    #[distributed_slice(EXAMPLE_DESCRIPTORS)]
    #[linkme(crate = paneweft::linkme)]
    static A_EXAMPLE: ExampleDescriptor = ExampleDescriptor { id: "a.example", type_id: "fx::T", claims: &["C1"], module: "module_a", source: SourceLocation { file: "src/lib.rs", line: 30 }, test_name: "module_a::paneweft_example_a", kind: ExampleKind::Example };
}

fn ids(catalogue: &Catalogue, key: &str) -> Vec<String> {
    catalogue.to_json()[key].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
}

// why: IV3. Registrations in separately linked modules reach one catalogue, sorted by id regardless of link order (b is linked
// before a here, a sorts first). The support module's macro-registered watch views are linked into this binary too, so the
// expectation lists them: absence of a linked descriptor would be silent coverage loss.
// proves: CLAIM(IV3)
#[test]
fn linked_registrations_from_separate_modules_form_one_sorted_catalogue() {
    let catalogue = Catalogue::linked().expect("linked catalogue");
    // Event is implemented by hand and registers nothing: only macro-declared views carry static descriptors.
    assert_eq!(ids(&catalogue, "views"), vec!["a.view", "b.view", "watch.events", "watch.status"]);
    assert_eq!(ids(&catalogue, "examples"), vec!["a.example"]);
}

// why: IV3, spec decision 3. The explicit-slice fallback builds the same catalogue from the same descriptors, and two registration
// orders give byte-identical JSON (the catalogue digest must not depend on link order).
// proves: CLAIM(IV3)
#[test]
fn the_explicit_slice_fallback_is_order_independent() {
    let forward = [view("a.view", "m", 1), view("b.view", "m", 2), view("c.view", "m", 3)];
    let backward = [view("c.view", "m", 3), view("a.view", "m", 1), view("b.view", "m", 2)];
    let one = Catalogue::from_descriptors(&forward, &[]).expect("forward");
    let two = Catalogue::from_descriptors(&backward, &[]).expect("backward");
    assert_eq!(one.to_json(), two.to_json());
    assert_eq!(ids(&one, "views"), vec!["a.view", "b.view", "c.view"]);
}

// why: IV3. A duplicate id reports BOTH declarations (file and line), so the author can find the second one without a search.
// proves: CLAIM(IV3)
#[test]
fn a_duplicate_view_id_names_both_sources() {
    let first = view("dup.view", "module_one", 11);
    let second = view("dup.view", "module_two", 22);
    match Catalogue::from_descriptors(&[first, second], &[]) {
        Err(CatalogueError::DuplicateId { id, kind, sources }) => {
            assert_eq!(id, "dup.view");
            assert_eq!(kind, "view");
            assert_eq!(sources, vec![("src/lib.rs".to_string(), 11), ("src/lib.rs".to_string(), 22)]);
        }
        other => panic!("expected DuplicateId naming both sources, got {other:?}"),
    }
}

// why: IV3/IV1. The `views` macro registers the descriptors of a type's views with their metadata and the line of the method's `fn`
// token. The expected line is found by scanning the support source for the fn, independent of the macro.
// proves: CLAIM(IV3) CLAIM(IV2)
#[test]
fn the_views_macro_registers_descriptors_with_metadata_and_source_lines() {
    let catalogue = Catalogue::linked().expect("linked catalogue");
    let json = catalogue.to_json();
    let status = json["views"].as_array().unwrap().iter().find(|v| v["id"] == "watch.status").expect("watch.status registered by the macro");
    let source = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/mod.rs")).unwrap();
    let line = source.lines().position(|l| l.contains("fn status_view(")).unwrap() + 1;
    assert_eq!(status["typeId"], "fixture::watch::WatchFile");
    assert_eq!(status["title"], "Status");
    assert_eq!(status["question"], "What state did this watch reach?");
    assert_eq!(status["component"], "shape");
    assert_eq!(status["priority"], 10);
    assert!(status["source"]["path"].as_str().unwrap().ends_with("tests/support/mod.rs"), "{}", status["source"]);
    assert_eq!(status["source"]["line"], json!(line));
}
