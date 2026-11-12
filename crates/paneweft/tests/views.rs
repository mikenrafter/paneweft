//! The authoring contract: borrowed values, bounded builders, tagged references and view failures (IV1, IV2 (Rust), S5, IV9 bounds).
//! Expected output is derived from the vigil question and written out literally; it is never computed by the builder under test.
mod support;
use paneweft::{Capture, CaptureOptions, Context, InspectOutcome, Inspectable, Limits, ObjectRef, ViewMeta, ViewSetResult};
use serde_json::{json, Value as Json};
use std::sync::atomic::{AtomicUsize, Ordering};
use support::{capture_watch, default_limits, event, must, WatchFile};

fn view<'a>(graph: &'a Json, id: &str) -> &'a Json {
    graph["views"].as_array().expect("views array").iter().find(|v| v["viewId"] == id).unwrap_or_else(|| panic!("graph has no view {id}: {}", graph))
}

// why: IV1. A borrowed WatchFile that is not Serialize produces a details view with exactly the question's fields, run evidence, and
// no log content. The expected shape data is hand-written from the spec's `watch.status` example.
// proves: CLAIM(IV1)
#[test]
fn status_view_is_a_shape_with_exactly_the_declared_fields_and_run_evidence() {
    let watch = WatchFile::with_events(vec![support::event("e-1", 3, false), support::event("e-2", 5, true)]);
    let graph = capture_watch(&watch, default_limits());
    let status = view(&graph, "watch.status");
    assert_eq!(status["component"], "shape");
    assert_eq!(status["title"], "Status");
    assert_eq!(status["question"], "What state did this watch reach?");
    assert_eq!(status["priority"], 10);
    assert_eq!(status["evidence"], json!({"provenance": "observed", "runId": "run-1"}));
    let field = |id: &str, ty: &str, example: Json| json!({"id": format!("details.{id}"), "path": format!("$.{id}"), "type": ty, "presence": "required", "example": example, "children": [], "provenance": "observed", "evidence": ["run"]});
    assert_eq!(
        status["data"],
        json!({
            "basis": "observed",
            "root": "details",
            "fields": [
                {"id": "details", "path": "$", "type": "object", "presence": "required", "children": ["details.status", "details.tick", "details.judge status", "details.event count"], "provenance": "observed", "evidence": ["run"]},
                field("status", "string", json!("Cancelled")),
                field("tick", "number", json!(7)),
                field("judge status", "string", json!("Idle")),
                field("event count", "number", json!(2)),
            ]
        })
    );
}

// why: IV1/IV21. The events list has one row per OCCURRENCE (id event-<index>), sorted by the declared order key with ties kept in
// insertion order, each row targeting its own captured object. Events arrive as e-2, e-1 so the sort is observable; e-2 is object o2.
// proves: CLAIM(IV1) CLAIM(IV21)
#[test]
fn events_view_rows_are_occurrences_sorted_stably_with_object_targets() {
    let watch = WatchFile::with_events(vec![support::event("e-2", 5, true), support::event("e-1", 3, false)]);
    let graph = capture_watch(&watch, default_limits());
    let events = view(&graph, "watch.events");
    assert_eq!(events["component"], "list");
    assert_eq!(
        events["data"],
        json!({
            "columns": [
                {"key": "event", "title": "Event", "format": "text"},
                {"key": "tick", "title": "Tick", "format": "number"},
                {"key": "redelivered", "title": "Redelivered", "format": "boolean"}
            ],
            "rows": [
                {"id": "event-1", "cells": {"event": "e-1", "tick": 3, "redelivered": false}, "provenance": "observed", "evidence": ["run"], "target": {"object": "o3"}},
                {"id": "event-0", "cells": {"event": "e-2", "tick": 5, "redelivered": true}, "provenance": "observed", "evidence": ["run"], "target": {"object": "o2"}}
            ],
            "order": {"key": "event", "direction": "asc"}
        })
    );
}

// why: IV21. Vigil documents that a failed save can redeliver an event with the same event_id and different contents. Two rows, two
// objects, both with the label/domain key e-1: nothing may deduplicate by display label.
// proves: CLAIM(IV21) CLAIM(IV9)
#[test]
fn redelivered_events_with_the_same_id_stay_two_rows_and_two_objects() {
    let watch = WatchFile::with_events(vec![support::event("e-1", 3, false), support::event("e-1", 5, true)]);
    let graph = capture_watch(&watch, default_limits());
    let rows = view(&graph, "watch.events")["data"]["rows"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["target"], json!({"object": "o2"}));
    assert_eq!(rows[1]["target"], json!({"object": "o3"}));
    assert_eq!(rows[0]["cells"]["tick"], json!(3));
    assert_eq!(rows[1]["cells"]["tick"], json!(5));
    let objects = graph["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 3, "watch plus two event objects");
    assert_eq!(objects[1]["domainKey"], "e-1");
    assert_eq!(objects[2]["domainKey"], "e-1");
    assert_ne!(objects[1]["contentHash"], objects[2]["contentHash"]);
}

// why: spec section 2 and IV1: `summary` can contain log content and the Event view omits it on purpose. The positive control proves
// the probe sees captured text (the event id is present), so the absence of the secret is meaningful.
// proves: CLAIM(IV1)
#[test]
fn an_omitted_field_never_reaches_the_graph() {
    let watch = WatchFile::with_events(vec![support::event("e-1", 3, false)]);
    let text = capture_watch(&watch, default_limits()).to_string();
    assert!(text.contains("e-1"), "positive control: captured text is searchable");
    assert!(!text.contains("SECRET LOG LINE"), "the omitted summary leaked into the capture");
}

// why: IV2 (Rust). The trait is the contract and works on a borrowed value that is not 'static: a struct holding a &str and a slice.
// The macro and the manual path produce the same shape of object record.
// proves: CLAIM(IV2)
#[test]
fn a_manual_implementation_works_on_a_non_static_borrowed_value() {
    struct Borrowed<'a> {
        name: &'a str,
        items: &'a [u32],
    }
    impl<'a> Inspectable for Borrowed<'a> {
        const PANEWEFT_TYPE_ID: &'static str = "fixture::Borrowed";
        fn views(&self, cx: &mut Context) -> ViewSetResult {
            const META: ViewMeta = ViewMeta { id: "borrowed.details", title: "Borrowed", question: "What is borrowed?", component: "shape", priority: 10 };
            let mut details = cx.details();
            details.field("name", self.name);
            details.field("count", self.items.len());
            let mut set = ViewSetResult::new();
            set.push(META, details.finish());
            set
        }
    }
    let local = String::from("local-name");
    let numbers = vec![1u32, 2, 3];
    let borrowed = Borrowed { name: &local, items: &numbers };
    let mut capture = Capture::new(CaptureOptions::default());
    let reference = must(capture.publish(&borrowed), "publish a borrowed value");
    assert_eq!(reference, ObjectRef::Captured("o1".to_string()));
    let graph = capture.finish().to_json();
    assert_eq!(graph["objects"][0]["typeId"], "fixture::Borrowed");
    assert_eq!(graph["objects"][0]["views"], json!(["borrowed.details"]));
    let fields = &view(&graph, "borrowed.details")["data"]["fields"];
    assert_eq!(fields[1]["example"], json!("local-name"));
    assert_eq!(fields[2]["example"], json!(3));
}

// why: S5. Builders are context-owned and bounded: the third row at a limit of two is refused with Full and an omission count; the
// view still succeeds (partial, never failed) with the two retained rows and the omission named at view and capture level.
// proves: CLAIM(S5-bounded-builders) CLAIM(IV9)
#[test]
fn a_full_table_refuses_rows_reports_the_omission_and_stays_a_partial_view() {
    use paneweft::Bounded;
    static REFUSED: AtomicUsize = AtomicUsize::new(0);
    struct Many(usize);
    impl Inspectable for Many {
        const PANEWEFT_TYPE_ID: &'static str = "fixture::Many";
        fn views(&self, cx: &mut Context) -> ViewSetResult {
            const META: ViewMeta = ViewMeta { id: "many.rows", title: "Rows", question: "Which rows?", component: "list", priority: 10 };
            let mut table = cx.table().text_column("n", "N");
            for index in 0..self.0 {
                if let Bounded::Full { omitted_so_far } = table.row(paneweft::Row::new(format!("r{index}")).cell("n", index)) {
                    REFUSED.store(omitted_so_far as usize, Ordering::SeqCst);
                }
            }
            let mut set = ViewSetResult::new();
            set.push(META, table.finish());
            set
        }
    }
    let limits = Limits { view_rows: 2, ..default_limits() };
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    must(capture.publish(&Many(4)), "publish");
    let graph = capture.finish().to_json();
    let rows = view(&graph, "many.rows");
    assert_eq!(rows["data"]["rows"].as_array().unwrap().len(), 2, "the two retained rows");
    assert_eq!(rows["completeness"], json!({"status": "partial", "reason": "row-limit", "omitted": {"rows": {"known": true, "count": 2}}}));
    assert_eq!(REFUSED.load(Ordering::SeqCst), 2, "the builder reported the running omission count to the view code");
    assert_eq!(graph["completeness"], json!({"status": "partial", "omitted": {"rows": {"known": true, "count": 2}}}));
}

// why: S5. `cx.reference()` beyond bounds returns a not-captured reference, not an error: the row still has a target state that says
// why. With an object limit of 1 the watch uses it up; the event reference is NotCaptured and the row target says so.
// proves: CLAIM(S5-bounded-builders)
#[test]
fn a_reference_beyond_the_object_limit_is_not_captured_and_not_an_error() {
    let watch = WatchFile::with_events(vec![support::event("e-1", 3, false)]);
    let graph = capture_watch(&watch, Limits { objects: 1, ..default_limits() });
    let rows = &view(&graph, "watch.events")["data"]["rows"];
    assert_eq!(rows[0]["target"], json!({"notCaptured": {"reason": "object-limit"}}));
    assert_eq!(graph["objects"].as_array().unwrap().len(), 1);
    assert!(graph["diagnostics"].as_array().unwrap().is_empty(), "a bound is not a diagnostic");
}

// why: spec section 4: rows beyond the page size are stored as content-addressed pages readable after the process exits. pageId is
// sha256 of the canonical JSON of the page rows, computed here independently with sha2.
// proves: CLAIM(IV10)
#[test]
fn rows_beyond_the_page_size_become_content_addressed_pages() {
    use sha2::{Digest, Sha256};
    let events: Vec<_> = (0..5).map(|i| event(&format!("e-{i}"), i, false)).collect();
    let watch = WatchFile::with_events(events);
    let graph = capture_watch(&watch, Limits { page_rows: 2, ..default_limits() });
    let list = view(&graph, "watch.events");
    assert_eq!(list["data"]["rows"].as_array().unwrap().len(), 2, "page 0 stays in the view");
    let pages = list["pages"].as_array().unwrap();
    assert_eq!(pages.iter().map(|p| (p["index"].as_u64().unwrap(), p["rowCount"].as_u64().unwrap())).collect::<Vec<_>>(), vec![(1, 2), (2, 1)]);
    assert_eq!(list["rowsTotal"], json!(5));
    let stored = graph["pages"].as_array().unwrap();
    assert_eq!(stored.len(), 2);
    for page in stored {
        let digest = Sha256::digest(serde_json::to_string(&page["rows"]).unwrap().as_bytes());
        let expected: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(page["pageId"], format!("sha256:{expected}"));
    }
    assert_eq!(stored[0]["rows"][0]["cells"]["event"], "e-2", "page 1 holds the third row onward in sorted order");
}

// why: spec section 4. With no active collector `inspect` returns the explicit inactive result and does no traversal: the view
// function is not called (a counter proves it) and no allocation of a graph happens.
// proves: CLAIM(IV4) CLAIM(IV1)
#[test]
fn inspect_without_a_collector_is_inactive_and_calls_no_view() {
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    struct Counting;
    impl Inspectable for Counting {
        const PANEWEFT_TYPE_ID: &'static str = "fixture::Counting";
        fn views(&self, _cx: &mut Context) -> ViewSetResult {
            CALLS.fetch_add(1, Ordering::SeqCst);
            ViewSetResult::new()
        }
    }
    assert_eq!(paneweft::inspect(&Counting), InspectOutcome::Inactive);
    assert_eq!(CALLS.load(Ordering::SeqCst), 0, "an inactive hook traversed");
    let graph = paneweft::with_capture(CaptureOptions::default(), || {
        assert!(matches!(paneweft::inspect(&Counting), InspectOutcome::Published(_)));
    });
    assert_eq!(CALLS.load(Ordering::SeqCst), 1, "positive control: the active hook traversed once");
    assert_eq!(graph.to_json()["objects"].as_array().unwrap().len(), 1);
}

// why: spec decision 10. A view that panics fails alone: the sibling view of the same object is preserved, NO record (not an empty
// successful one) exists for the failed view, and a diagnostic names it with the panic message.
// proves: CLAIM(IV1) CLAIM(IV17)
#[test]
fn a_panicking_view_is_isolated_and_diagnosed_by_view_id() {
    struct Mixed;
    #[paneweft::views(type_id = "fixture::Mixed")]
    impl Mixed {
        #[paneweft::view(id = "mixed.good", title = "Good", component = "shape", priority = 10, question = "Is it good?")]
        fn good(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
            let mut details = cx.details();
            details.field("ok", true);
            details.finish()
        }
        #[paneweft::view(id = "mixed.bad", title = "Bad", component = "shape", priority = 20, question = "Does it fail?")]
        fn bad(&self, _cx: &mut paneweft::Context) -> paneweft::ViewResult {
            panic!("view blew up")
        }
    }
    let mut capture = Capture::new(CaptureOptions::default());
    must(capture.publish(&Mixed), "publish");
    let graph = capture.finish().to_json();
    assert_eq!(graph["views"].as_array().unwrap().len(), 1, "only the good view has a record");
    assert_eq!(graph["views"][0]["viewId"], "mixed.good");
    let diagnostics = graph["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["category"], "view-exception");
    assert_eq!(diagnostics[0]["viewId"], "mixed.bad");
    assert!(diagnostics[0]["message"].as_str().unwrap().contains("view blew up"));
}

// why: the unsupported view of the test above, with its own panic-free type, so the assertion about its record is not hidden by the
// panic of another view.
// proves: CLAIM(IV1)
#[test]
fn an_unsupported_view_records_a_reason_and_no_data() {
    struct OnlyUnsupported;
    impl Inspectable for OnlyUnsupported {
        const PANEWEFT_TYPE_ID: &'static str = "fixture::OnlyUnsupported";
        fn views(&self, _cx: &mut Context) -> ViewSetResult {
            let mut set = ViewSetResult::new();
            set.push(ViewMeta { id: "only.unsupported", title: "Not here", question: "Does it apply?", component: "shape", priority: 20 }, Ok(paneweft::View::unsupported("needs the live process")));
            set
        }
    }
    let mut capture = Capture::new(CaptureOptions::default());
    must(capture.publish(&OnlyUnsupported), "publish");
    let graph = capture.finish().to_json();
    let record = view(&graph, "only.unsupported");
    assert_eq!(record["completeness"], json!({"status": "unsupported", "reason": "needs the live process"}));
    assert_eq!(record["unsupportedReason"], "needs the live process");
    assert!(record.get("data").is_none(), "an unsupported view carries no data");
}

// why: S5/spec section 4: a field set larger than the string limit is tagged truncated in the record (never silently cut), and the
// view that displayed it names the omitted count under "strings".
// proves: CLAIM(IV9) CLAIM(S11-tagged-values)
#[test]
fn an_oversized_string_field_is_truncated_with_a_tag_and_counted() {
    struct Wordy;
    impl Inspectable for Wordy {
        const PANEWEFT_TYPE_ID: &'static str = "fixture::Wordy";
        fn views(&self, cx: &mut Context) -> ViewSetResult {
            cx.field("text", "é".repeat(10));
            ViewSetResult::new()
        }
    }
    let mut capture = Capture::new(CaptureOptions { limits: Limits { string_bytes: 8, ..default_limits() }, ..CaptureOptions::default() });
    must(capture.publish(&Wordy), "publish");
    let graph = capture.finish().to_json();
    assert_eq!(graph["objects"][0]["fields"]["text"], json!({"$paneweft": "truncated", "text": "éééé", "keptBytes": 8, "omittedBytes": 12}));
    assert_eq!(graph["completeness"], json!({"status": "partial", "omitted": {"strings": {"known": true, "count": 1}}}));
}
