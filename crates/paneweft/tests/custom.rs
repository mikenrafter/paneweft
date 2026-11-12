//! WHY CLAIM(S34): the macro and SDK must make custom renderer emission reachable with a mandatory standard fallback.
use paneweft::{Capture, CaptureOptions, Context, Value, ViewResult};
struct Payload { label: String }
impl From<Payload> for Value {
    fn from(payload: Payload) -> Self { Value::map(vec![("label", Value::Str(payload.label))]) }
}
struct Card { label: String }
#[paneweft::views(type_id = "test::Card")]
impl Card {
    #[paneweft::view(id = "card.view", title = "Card", question = "Which card?", component = "custom", priority = 1)]
    fn card(&self, cx: &mut Context) -> ViewResult {
        let renderer = paneweft::Renderer::<Payload>::new("card", 1, &"a".repeat(64), &"b".repeat(64));
        let mut details = cx.details();
        details.field("label", "long");
        let fallback = details.finish()?;
        cx.custom(&renderer, Payload { label: self.label.clone() }, fallback, &[])
    }
}
#[test]
fn s34_custom_is_bounded_and_has_fallback() {
    let mut capture = Capture::new(CaptureOptions::default());
    capture.publish(&Card { label: "long".into() }).unwrap();
    let graph = capture.finish().to_json();
    assert_eq!(graph["diagnostics"], serde_json::json!([]));
    assert_eq!(graph["views"][0]["component"], "custom");
    assert_eq!(graph["views"][0]["data"]["payload"]["label"], "long");
    assert_eq!(graph["views"][0]["data"]["fallback"]["component"], "shape");
}

// WHY CLAIM(S34): the standard facts survive even when the bounded overlay cannot fit.
#[test]
fn s34_keeps_fallback_when_overlay_has_no_room() {
    let limits = paneweft::Limits { root_bytes: 4096, collection_bytes: 8192, ..paneweft::Limits::default() };
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    capture.publish(&Card { label: "x".repeat(100000) }).unwrap();
    let graph = capture.finish();
    assert!(!graph.emergency());
    let document = graph.to_json();
    assert_eq!(document["views"][0]["component"], "shape");
    assert_eq!(document["views"][0]["data"]["fields"][1]["example"], "long");
    assert_eq!(document["views"][0]["completeness"]["status"], "partial");
    assert!(graph.text().len() <= 8192);
}
