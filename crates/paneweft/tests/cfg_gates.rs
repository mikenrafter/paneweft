//! Fix round 1, S17: a declaration compiled out by `#[cfg]` leaves nothing generated behind that refers to it.
//! Before the fix this file did not compile: the generated `set.run(.., |cx| self.gone(cx))` and the example's test wrapper named items that
//! `#[cfg(any())]` had removed.
use paneweft::{Context, Value, ViewResult};

struct Gated;

#[paneweft::views(type_id = "t::Gated")]
impl Gated {
    #[cfg(any())]
    #[paneweft::view(id = "gated.gone", title = "Gone", component = "shape", priority = 1, question = "Is this compiled in?")]
    fn gone(&self, cx: &mut Context) -> ViewResult {
        cx.details().finish()
    }

    #[paneweft::view(id = "gated.kept", title = "Kept", component = "shape", priority = 2, question = "Is this compiled in?")]
    fn kept(&self, cx: &mut Context) -> ViewResult {
        let mut details = cx.details();
        details.field("kept", Value::from(true));
        details.finish()
    }
}

#[paneweft::example(id = "gated.example.gone", claims = ["G1"])]
#[cfg(any())]
fn gone_example() -> Gated {
    Gated
}

#[paneweft::example(id = "gated.example.kept", claims = ["G2"])]
#[cfg(not(any()))]
fn kept_example() -> Gated {
    paneweft::check!("G2", true);
    Gated
}

// why: S17. The view whose method is compiled out is neither run nor described; its sibling still is.
// proves: CLAIM(S17-cfg)
#[test]
fn a_view_compiled_out_by_cfg_is_neither_run_nor_catalogued() {
    let mut capture = paneweft::Capture::new(paneweft::CaptureOptions::default());
    capture.publish(&Gated).expect("publish");
    let graph = capture.finish().to_json();
    let ids: Vec<&str> = graph["views"].as_array().unwrap().iter().map(|v| v["viewId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["gated.kept"]);
    let described: Vec<&str> = paneweft::catalogue::VIEW_DESCRIPTORS.iter().filter(|d| d.type_id == "t::Gated").map(|d| d.id).collect();
    assert_eq!(described, vec!["gated.kept"]);
}

// why: S17. The same for an example: no wrapper test and no descriptor for the one compiled out, both for the one that stays.
// proves: CLAIM(S17-cfg)
#[test]
fn an_example_compiled_out_by_cfg_is_not_described() {
    let described: Vec<&str> = paneweft::catalogue::EXAMPLE_DESCRIPTORS.iter().filter(|d| d.id.starts_with("gated.example.")).map(|d| d.id).collect();
    assert_eq!(described, vec!["gated.example.kept"]);
}
