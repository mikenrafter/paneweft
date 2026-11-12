//! Fix round 2, S23: the byte reserved for a view's record frame belongs to ONE invocation of a view on ONE object. A child that runs the same
//! view as its parent, or one that is refused, must neither take over nor give back its parent's reservation.
mod support;
use paneweft::{Capture, CaptureOptions, Context, Inspectable, Limits, ViewMeta, ViewSetResult};
use serde_json::Value as Json;
use support::default_limits;

/// A node of a tree. `SameView` nodes all run `view.a`; in `DistinctViews` the parent type runs `view.a` and its children run `view.b` (a view of the
/// same size under another id), so the two trees cost the same bytes and differ only in whether a child's view id equals its parent's.
#[derive(Clone, Copy, PartialEq)]
enum Shape {
    SameView,
    DistinctViews,
}

struct Node {
    shape: Shape,
    depth: u32,
    /// Bytes of padding the view adds AFTER it has referenced its children: it takes whatever room is left.
    pad: usize,
}

const A: ViewMeta = ViewMeta { id: "view.a", title: "Node", question: "What is here?", component: "shape", priority: 1 };
const B: ViewMeta = ViewMeta { id: "view.b", title: "Node", question: "What is here?", component: "shape", priority: 1 };

impl Inspectable for Node {
    const PANEWEFT_TYPE_ID: &'static str = "t::N";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        let mut set = ViewSetResult::new();
        let meta = if self.shape == Shape::DistinctViews && self.depth > 0 { B } else { A };
        set.run(cx, meta, |cx| {
            if self.depth < 2 {
                let child = Node { shape: self.shape, depth: self.depth + 1, pad: self.pad };
                cx.reference_named("child", &child).expect("reference");
            }
            if self.pad > 0 {
                cx.field("pad", "p".repeat(self.pad));
            }
            let mut details = cx.details();
            details.field("depth", self.depth);
            details.finish()
        });
        set
    }
}

fn run(shape: Shape, pad: usize, budget: u64) -> Json {
    let limits = Limits { collection_bytes: budget, root_bytes: 10_000_000, ..default_limits() };
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    capture.publish(&Node { shape, depth: 0, pad }).expect("publishes");
    capture.finish().to_json()
}

fn views_of(graph: &Json) -> usize { graph["views"].as_array().unwrap().len() }
fn complete(graph: &Json, views: usize) -> bool { views_of(graph) == views && graph["completeness"]["status"] == "complete" && graph["diagnostics"].as_array().unwrap().is_empty() }

/// The smallest budget (searched in steps of 4 bytes) under which `make` yields a graph satisfying `ok`.
fn smallest_budget(make: impl Fn(u64) -> Json, ok: impl Fn(&Json) -> bool) -> u64 {
    (200..8000u64).step_by(4).find(|budget| ok(&make(*budget))).expect("some budget in range satisfies the check")
}

// why: S23. Reservations were keyed by view id alone. A child that runs the SAME view as its parent overwrote the parent's reservation, then
// removed it when its own record settled; the parent's record was charged again and the parent's reserved bytes were never returned. The
// smallest budget that holds a three-level tree was therefore larger when the levels share a view id than when they do not, though the two
// trees are the same size. Rejects an implementation that keys the reservation by view id.
// proves: CLAIM(S23-reservation)
#[test]
fn a_child_running_the_same_view_neither_takes_nor_loses_its_parents_reservation() {
    let same = smallest_budget(|budget| run(Shape::SameView, 0, budget), |graph| complete(graph, 3));
    let distinct = smallest_budget(|budget| run(Shape::DistinctViews, 0, budget), |graph| complete(graph, 3));
    assert_eq!(same, distinct, "the same-view tree needs {same} bytes, the distinct-view tree {distinct}");
}

// why: S23. A child whose view is refused (no room for its frame) settled with the reservation of the PARENT's view of the same id and gave it
// back. The parent's view then took the room it had reserved, and when it settled it had no room left: the view was lost although it had paid for
// its place. Every budget at which a child exists without its view must keep the parent's view.
// proves: CLAIM(S23-reservation)
#[test]
fn a_refused_child_does_not_refund_its_parents_reservation() {
    let mut refused_child_budgets = 0;
    for budget in (200..8000u64).step_by(2) {
        let graph = run(Shape::SameView, 4000, budget);
        let objects = graph["objects"].as_array().unwrap();
        let child_without_view = objects.len() >= 2 && objects[1]["views"].as_array().unwrap().is_empty();
        if !child_without_view {
            continue;
        }
        refused_child_budgets += 1;
        let parent_views = objects[0]["views"].as_array().unwrap();
        assert_eq!(parent_views, &vec![Json::from("view.a")], "budget {budget}: the parent lost its view although it reserved the room: {graph}");
    }
    assert!(refused_child_budgets > 0, "the scan must reach budgets at which a child is captured without its view");
}

struct PanicsAfterAView;
impl Inspectable for PanicsAfterAView {
    const PANEWEFT_TYPE_ID: &'static str = "t::P";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        let mut set = ViewSetResult::new();
        // a view that builds nothing: only its reservation is spent, so only the reservation can be left over
        set.run(cx, A, |_| Ok(paneweft::View::unsupported("nothing to show")));
        panic!("views() panics");
    }
}
struct PanicsBeforeAnyView;
impl Inspectable for PanicsBeforeAnyView {
    const PANEWEFT_TYPE_ID: &'static str = "t::P";
    fn views(&self, _cx: &mut Context) -> ViewSetResult { panic!("views() panics") }
}

// why: S23, sibling. When `views()` panics, the set it was building is lost, and so are the entries whose reservations are still open: they were
// never settled. The bytes stay spent for the rest of the capture. A panic after a view ran must cost what a panic before it did.
// proves: CLAIM(S23-reservation)
#[test]
fn a_panic_gives_back_the_reservations_of_the_views_it_lost() {
    let after = smallest_budget(
        |budget| {
            let limits = Limits { collection_bytes: budget, root_bytes: 10_000_000, ..default_limits() };
            let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
            capture.publish(&PanicsAfterAView).expect("publishes");
            capture.publish(&Node { shape: Shape::SameView, depth: 2, pad: 0 }).expect("publishes");
            capture.finish().to_json()
        },
        |graph| graph["views"].as_array().unwrap().len() == 1,
    );
    let before = smallest_budget(
        |budget| {
            let limits = Limits { collection_bytes: budget, root_bytes: 10_000_000, ..default_limits() };
            let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
            capture.publish(&PanicsBeforeAnyView).expect("publishes");
            capture.publish(&Node { shape: Shape::SameView, depth: 2, pad: 0 }).expect("publishes");
            capture.finish().to_json()
        },
        |graph| graph["views"].as_array().unwrap().len() == 1,
    );
    assert_eq!(after, before, "after a panic that lost a settled-less view the next object needs {after} bytes, after a plain panic {before}");
}
