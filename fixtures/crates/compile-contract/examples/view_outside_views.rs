// CONTRACT: `#[paneweft::view]` outside a `#[paneweft::views]` impl is an error that names the fix.
struct Plain;

impl Plain {
    #[paneweft::view(id = "plain.view", title = "T", component = "shape", priority = 10, question = "Is it plain?")]
    fn plain_view(&self, _cx: &mut paneweft::Context) -> paneweft::ViewResult {
        Err(paneweft::capture::ViewError { category: "x".into(), message: "y".into() })
    }
}

fn main() {}
