// CONTRACT (IV18, control): a renamed field is caught by rustc itself, inside the view body, with a span in THIS file. The macro
// must leave the method body untouched so the compiler points at the author's own line.
struct Renamed {
    tick_count: u64,
}

#[paneweft::views(type_id = "contract::Renamed")]
impl Renamed {
    #[paneweft::view(id = "renamed.status", title = "Status", component = "shape", priority = 10, question = "Which tick?")]
    fn status_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
        let mut details = cx.details();
        details.field("tick", self.tick); // field was renamed to tick_count: must not compile
        details.finish()
    }
}

fn main() {
    let _ = Renamed { tick_count: 1 }.tick_count;
}
