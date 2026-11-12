//! F18: a large real object keeps its main list. A root whose list view has one row per child object (`cx.reference_keyed`, as vigil's `WatchFile` does for its events)
//! used to lose the list entirely: the children were captured first and spent the root's byte budget, so by the time the list was built nothing was left for its frame
//! and the view was `unsupported` with zero rows. The SDK bounds tests used tables without child references, which is why nothing caught it.
mod support;
use paneweft::{Capture, CaptureOptions, Context, Inspectable, Row, ViewMeta, ViewSetResult};
use serde_json::Value as Json;
use support::default_limits;

struct Event(u64);
struct Watch {
    events: Vec<Event>,
}

const EVENT_DETAILS: ViewMeta = ViewMeta { id: "event.details", title: "Event", question: "What is in this event?", component: "shape", priority: 1 };
const STATUS: ViewMeta = ViewMeta { id: "watch.status", title: "Status", question: "How many events?", component: "shape", priority: 1 };
const EVENTS: ViewMeta = ViewMeta { id: "watch.events", title: "Events", question: "Which events were retained, and were they redelivered?", component: "list", priority: 2 };

impl Inspectable for Event {
    const PANEWEFT_TYPE_ID: &'static str = "t::Event";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        let mut set = ViewSetResult::new();
        set.run(cx, EVENT_DETAILS, |cx| {
            let mut details = cx.details();
            details.field("id", format!("event-{}", self.0));
            details.field("kind", "line");
            details.field("position", self.0);
            details.finish()
        });
        set
    }
}

impl Inspectable for Watch {
    const PANEWEFT_TYPE_ID: &'static str = "t::Watch";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        let mut set = ViewSetResult::new();
        set.run(cx, STATUS, |cx| {
            let mut details = cx.details();
            details.field("event count", self.events.len());
            details.finish()
        });
        set.run(cx, EVENTS, |cx| {
            let mut table = cx.table().text_column("event", "Event").number_column("position", "Position");
            for event in &self.events {
                let target = cx.reference_keyed(event, &format!("event-{}", event.0))?;
                table.row(Row::new(format!("event-{}", event.0)).cell("event", format!("event-{}", event.0)).cell("position", event.0).target(target));
            }
            table.finish()
        });
        set
    }
}

fn capture(events: u64) -> Json {
    let watch = Watch { events: (0..events).map(Event).collect() };
    let mut capture = Capture::new(CaptureOptions { limits: default_limits(), ..CaptureOptions::default() });
    capture.publish(&watch).expect("publishes");
    capture.finish().to_json()
}

fn view<'a>(graph: &'a Json, id: &str) -> &'a Json { graph["views"].as_array().unwrap().iter().find(|v| v["viewId"] == id && v["objectId"] == "o1").unwrap_or_else(|| panic!("no view {id} on the root")) }

// why: F18. 20 000 events, each row referencing its event. The field test returned `unsupported` with zero rows ("the byte budget of this capture is used up"). The list is the
// answer to the view's own question: it keeps its rows (a partial list that says how many it omitted), its first rows come first, and the events that did not fit are
// named as not captured on their rows. The capture stays inside its bound.
// proves: CLAIM(F18-rows-before-children)
#[test]
fn a_list_with_child_references_keeps_its_rows_when_the_budget_is_exhausted() {
    let graph = capture(20_000);
    let list = view(&graph, "watch.events");
    assert_eq!(list["completeness"]["status"], "partial", "{}", list["completeness"]);
    assert_eq!(list["completeness"]["reason"], "row-limit");
    let first_page = list["data"]["rows"].as_array().unwrap().len() as u64;
    let stored: u64 = list["pages"].as_array().unwrap().iter().map(|p| p["rowCount"].as_u64().unwrap()).sum();
    let kept = list["rowsTotal"].as_u64().unwrap();
    assert_eq!(first_page + stored, kept, "rowsTotal counts every retained row");
    assert!(kept >= 1_000, "the list keeps at least a thousand of its rows, kept {kept}");
    let omitted = list["completeness"]["omitted"]["rows"]["count"].as_u64().unwrap();
    assert_eq!(kept + omitted, 20_000, "kept and omitted rows account for every event");
    assert_eq!(list["data"]["rows"][0]["id"], "event-0", "the rows that are kept are the first rows");
    // rows whose event did not fit say so: a not-captured target, with the bound that stopped it
    let rows: Vec<&Json> = list["data"]["rows"].as_array().unwrap().iter().chain(graph["pages"].as_array().unwrap().iter().flat_map(|p| p["rows"].as_array().unwrap().iter())).collect();
    let not_captured = rows.iter().filter(|row| row["target"].get("notCaptured").is_some()).count();
    let captured = rows.iter().filter(|row| row["target"].get("object").is_some()).count();
    assert!(captured > 0 && not_captured > 0, "captured {captured}, not captured {not_captured}");
    assert!(graph["completeness"]["omitted"]["objects"]["count"].as_u64().is_some() || graph["completeness"]["omitted"]["rootBytes"]["count"].as_u64().is_some(), "{}", graph["completeness"]);
    let status = view(&graph, "watch.status");
    assert_eq!(status["completeness"]["status"], "complete", "the small view of the root survives too");
    let charged = graph["objects"].to_string().len() + graph["views"].to_string().len() + graph["pages"].to_string().len() + graph["diagnostics"].to_string().len();
    assert!(charged <= 2 * 1024 * 1024, "the root stays within rootBytes, charged {charged}");
}

// why: F18 control. A list that fits is untouched: every row, every child captured, complete. Rejects a fix that halves everything.
// proves: CLAIM(F18-rows-before-children)
#[test]
fn a_list_that_fits_is_complete_with_every_child_captured() {
    let graph = capture(50);
    let list = view(&graph, "watch.events");
    assert_eq!(list["completeness"]["status"], "complete");
    assert_eq!(list["rowsTotal"], 50);
    assert_eq!(graph["objects"].as_array().unwrap().len(), 51);
}
