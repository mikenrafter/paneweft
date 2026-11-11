//! Fix round 1, S9: a borrowed address is not an identity. Two references are one observation only when the caller says so.
mod support;
use paneweft::{Capture, CaptureOptions, Context, Inspectable, ViewMeta, ViewSetResult};
use serde_json::{json, Value as Json};
use std::cell::Cell;

struct Child {
    n: Cell<u32>,
}

impl Inspectable for Child {
    const PANEWEFT_TYPE_ID: &'static str = "t::Child";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        cx.field("n", self.n.get());
        ViewSetResult::new()
    }
}

#[derive(Clone, Copy)]
enum Mode {
    TemporariesInALoop,
    MutatedBetweenReferences,
    ExplicitIdentity,
}

struct Parent(Mode);

#[inline(never)]
fn reference_a_temporary(cx: &mut Context, n: u32) {
    let child = Child { n: Cell::new(n) };
    cx.reference_named("temp", &child).expect("reference");
}

impl Inspectable for Parent {
    const PANEWEFT_TYPE_ID: &'static str = "t::Parent";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        match self.0 {
            Mode::TemporariesInALoop => {
                for n in 1..=3 {
                    reference_a_temporary(cx, n);
                }
                for n in 4..=5 {
                    let child = Child { n: Cell::new(n) };
                    cx.reference_named("loop", &child).expect("reference");
                }
            }
            Mode::MutatedBetweenReferences => {
                let child = Child { n: Cell::new(1) };
                cx.reference_named("first", &child).expect("reference");
                child.n.set(2);
                cx.reference_named("second", &child).expect("reference");
            }
            Mode::ExplicitIdentity => {
                let child = Child { n: Cell::new(1) };
                cx.reference_with_identity("first", None, &child, "the-child").expect("reference");
                cx.reference_with_identity("second", None, &child, "the-child").expect("reference");
            }
        }
        let _ = ViewMeta { id: "", title: "", question: "", component: "shape", priority: 0 };
        ViewSetResult::new()
    }
}

fn capture(mode: Mode) -> Json {
    let mut capture = Capture::new(CaptureOptions::default());
    capture.publish(&Parent(mode)).expect("publish");
    capture.finish().to_json()
}

fn field_values(graph: &Json) -> Vec<u64> {
    let mut values: Vec<u64> = graph["objects"].as_array().unwrap().iter().filter(|o| o["typeId"] == "t::Child").map(|o| o["fields"]["n"].as_u64().unwrap()).collect();
    values.sort();
    values
}

// why: S9. Capture deduplicated by the typed address for the whole publish call. The stack slot of a temporary child is reused by the next
// one, so five distinct children (n = 1..5) merged into one object that kept only the first observation. Rejects an implementation that
// keys the object map by `value as *const T`.
// proves: CLAIM(S9-borrowed-address)
#[test]
fn temporaries_that_reuse_a_stack_slot_stay_distinct_objects() {
    let graph = capture(Mode::TemporariesInALoop);
    assert_eq!(field_values(&graph), vec![1, 2, 3, 4, 5], "{graph}");
}

// why: S9. A value mutated between two references used to come back as the OLD observation (an alias to the first object). Two references
// are two observations of two states.
// proves: CLAIM(S9-borrowed-address)
#[test]
fn a_value_mutated_between_two_references_is_two_observations() {
    let graph = capture(Mode::MutatedBetweenReferences);
    assert_eq!(field_values(&graph), vec![1, 2], "{graph}");
    let edges = graph["objects"][0]["edges"].as_array().unwrap();
    assert!(edges.iter().all(|e| e["kind"] == "child"), "no alias edge: {edges:?}");
}

// why: S9. Sharing is still possible, and explicit: the same identity token makes the second reference an alias of the first object.
// proves: CLAIM(S9-borrowed-address) CLAIM(IV9)
#[test]
fn an_explicit_identity_makes_two_references_one_object() {
    let graph = capture(Mode::ExplicitIdentity);
    assert_eq!(field_values(&graph), vec![1]);
    let edges = graph["objects"][0]["edges"].clone();
    assert_eq!(edges, json!([{"name": "first", "kind": "child", "target": "o2"}, {"name": "second", "kind": "alias", "target": "o2"}]));
}
