//! Fix round 1, S2 and S3 (Rust): the byte budgets are charged while the graph is built, and a caller can only lower a bound.
//! The same scenarios as packages/paneweft-ts/src/bounds.test.ts.
mod support;
use paneweft::{Capture, CaptureOptions, Context, Inspectable, Limits, Row, Value, ViewMeta, ViewSetResult};
use serde_json::{json, Value as Json};
use std::time::Instant;
use support::default_limits;

struct Big {
    items: Value,
    rows: usize,
}

const DETAILS: ViewMeta = ViewMeta { id: "big.details", title: "Big", question: "What does the object hold?", component: "shape", priority: 1 };
const ROWS: ViewMeta = ViewMeta { id: "big.rows", title: "Rows", question: "Which rows?", component: "list", priority: 2 };

impl Inspectable for Big {
    const PANEWEFT_TYPE_ID: &'static str = "t::Big";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        let mut set = ViewSetResult::new();
        set.run(cx, DETAILS, |cx| {
            cx.field("items", self.items.clone());
            let mut details = cx.details();
            details.field("kind", "big");
            details.finish()
        });
        set.run(cx, ROWS, |cx| {
            let mut table = cx.table().text_column("n", "N").number_column("v", "V");
            for i in 0..self.rows {
                table.row(Row::new(format!("r{i}")).cell("n", format!("row {i}")).cell("v", i));
            }
            table.finish()
        });
        set
    }
}

fn bytes(json: &Json) -> usize { json.to_string().len() }

/// What the budgets cover: the object records, the view records with their data, the stored page bodies and the diagnostics.
fn charged(graph: &Json) -> usize { bytes(&graph["objects"]) + bytes(&graph["views"]) + bytes(&graph["pages"]) + bytes(&graph["diagnostics"]) }

fn publish(big: &Big, change: impl FnOnce(&mut Limits)) -> Json {
    let mut limits = default_limits();
    change(&mut limits);
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    capture.publish(big).expect("publishes");
    capture.finish().to_json()
}

fn numbers(count: usize) -> Value { Value::List((0..count as i64).map(Value::from).collect()) }

// why: S2. A 20,000-element field under collection_bytes=2048 produced about 25 KB and reported the capture complete, because the bytes were
// measured after the object was built and the field was never limited. Rejects an implementation that sums sizes after construction.
// proves: CLAIM(S2-budgets)
#[test]
fn the_whole_collection_stays_within_collection_bytes_and_says_what_was_cut() {
    let graph = publish(&Big { items: numbers(20_000), rows: 0 }, |l| l.collection_bytes = 2048);
    assert!(charged(&graph) <= 2048, "charged {} bytes", charged(&graph));
    assert_eq!(graph["completeness"]["status"], "partial");
    assert!(graph["completeness"]["omitted"]["values"]["count"].as_u64().unwrap() > 19_000);
    let items = graph["objects"][0]["fields"]["items"].as_array().expect("items is an array");
    assert_eq!(items.last().unwrap(), &json!({"$paneweft": "not-captured", "reason": "collection-limit"}));
    assert_eq!(items[..5], [json!(0), json!(1), json!(2), json!(3), json!(4)]);
}

// why: S2. root_bytes bounds one root's subtree the same way, and its marker names the root budget.
// proves: CLAIM(S2-budgets)
#[test]
fn a_root_stays_within_root_bytes() {
    let graph = publish(&Big { items: numbers(20_000), rows: 0 }, |l| l.root_bytes = 1500);
    assert!(charged(&graph) <= 1500, "charged {} bytes", charged(&graph));
    assert_eq!(graph["completeness"]["status"], "partial");
    let items = graph["objects"][0]["fields"]["items"].as_array().unwrap();
    assert_eq!(items.last().unwrap(), &json!({"$paneweft": "not-captured", "reason": "root-bytes-limit"}));
}

// why: S2. Stored page bodies were excluded from the accounting, so a table of 5,000 rows under a small budget stored every row in pages.
// They are charged like first-page rows; the rows that do not fit are dropped and counted, never silently.
// proves: CLAIM(S2-budgets)
#[test]
fn stored_page_bodies_are_charged_and_the_rows_that_do_not_fit_are_dropped() {
    let graph = publish(&Big { items: Value::from(1), rows: 5000 }, |l| {
        l.collection_bytes = 12_000;
        l.page_rows = 10;
    });
    assert!(charged(&graph) <= 12_000, "charged {} bytes", charged(&graph));
    let view = graph["views"].as_array().unwrap().iter().find(|v| v["viewId"] == "big.rows").unwrap_or_else(|| panic!("no rows view: {graph}"));
    let kept = view["rowsTotal"].as_u64().unwrap();
    assert!(kept < 5000);
    assert_eq!(view["completeness"]["status"], "partial");
    assert_eq!(view["completeness"]["omitted"]["rows"]["count"].as_u64().unwrap(), 5000 - kept);
    let stored: usize = graph["pages"].as_array().unwrap().iter().map(|p| p["rows"].as_array().unwrap().len()).sum();
    assert_eq!(stored + view["data"]["rows"].as_array().unwrap().len(), kept as usize);
}

// why: S2. The encoder walked whatever container it was given. A list of a million elements and a map of 200,000 entries are cut after the
// budget, in time proportional to the output.
// proves: CLAIM(S2-budgets)
#[test]
fn a_huge_container_is_cut_after_its_budget() {
    let map = Value::Map((0..200_000).map(|i| (format!("m{i}"), Value::from(i as i64))).collect());
    for items in [numbers(1_000_000), map] {
        let started = Instant::now();
        let graph = publish(&Big { items, rows: 0 }, |l| l.collection_bytes = 4096);
        assert!(charged(&graph) <= 4096, "charged {} bytes", charged(&graph));
        assert!(graph["completeness"]["omitted"]["values"]["count"].as_u64().unwrap() > 1000);
        assert!(started.elapsed().as_millis() < 2500, "took {:?}", started.elapsed());
    }
}

// why: S2. A string longer than the room left is cut to it, not just to string_bytes.
// proves: CLAIM(S2-budgets)
#[test]
fn a_string_is_cut_to_the_room_that_is_left() {
    let graph = publish(&Big { items: Value::from("x".repeat(1_000_000)), rows: 0 }, |l| l.collection_bytes = 1024);
    assert!(charged(&graph) <= 1024, "charged {} bytes", charged(&graph));
    assert_eq!(graph["completeness"]["status"], "partial");
}

// why: control. With room to spare nothing is cut and the capture is complete.
// proves: CLAIM(S2-budgets)
#[test]
fn everything_that_fits_is_complete_and_unchanged() {
    let graph = publish(&Big { items: numbers(50), rows: 0 }, |_| {});
    assert_eq!(graph["completeness"], json!({"status": "complete"}));
    assert_eq!(graph["objects"][0]["fields"]["items"], json!((0..50).collect::<Vec<i64>>()));
}

// why: S3. Overrides replaced the limits and narrowed integers unchecked: 4294967303 became 7 objects, and a request for 10^12 objects was
// honoured. Rejects an implementation that assigns `n as u32` or the raw number.
// proves: CLAIM(S3-clamp)
#[test]
fn an_override_never_raises_a_bound_and_never_wraps() {
    let base = Limits::default();
    let raised = base.with_overrides(&json!({"objects": 1_000_000_000_000u64, "collectionBytes": 1u64 << 50, "rootBytes": 1u64 << 50, "depth": 99, "viewBudgetMs": 1u64 << 40, "stringBytes": 1u64 << 31, "pageRows": 5000, "roots": 1_000_000, "references": 100_000_000, "viewRows": 1_000_000_000}));
    assert_eq!(raised, base);
    let wrapped = base.with_overrides(&json!({"objects": 4_294_967_303u64, "depth": 4_294_967_297u64, "pageRows": 4_294_967_296u64}));
    assert_eq!(wrapped, base, "a number past u32 is a request for more, not a small number");
}

// why: S3. Lowering still works, to the schema minimum at the least; a ceiling below the limits (an operator who allows less) wins.
// proves: CLAIM(S3-clamp)
#[test]
fn an_override_lowers_a_bound_and_honours_a_lower_ceiling() {
    let base = Limits::default();
    let lowered = base.with_overrides(&json!({"objects": 5, "depth": 0, "pageRows": 0}));
    assert_eq!((lowered.objects, lowered.depth, lowered.page_rows), (5, 0, 1));
    let ceiling = Limits { objects: 50, ..base };
    assert_eq!(base.with_overrides_under(&json!({"objects": 500}), &ceiling).objects, 50);
}

// why: S3. A name or value that is not a valid bound is ignored: floats, negatives, strings, unknown names, and an override that is not an object.
// proves: CLAIM(S3-clamp)
#[test]
fn an_override_that_is_not_an_integer_bound_is_ignored() {
    let base = Limits::default();
    assert_eq!(base.with_overrides(&json!({"objects": 1.5, "depth": -1, "roots": "5", "bogus": 3})), base);
    assert_eq!(base.with_overrides(&json!(null)), base);
    assert_eq!(base.with_overrides(&json!([7])), base);
}
