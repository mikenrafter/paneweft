// CONTRACT: examples are zero-argument factories; a parameter is an error naming the rule.
use paneweft::{Context, Inspectable, ViewSetResult};

struct Subject;
impl Inspectable for Subject {
    const PANEWEFT_TYPE_ID: &'static str = "contract::Subject";
    fn views(&self, _cx: &mut Context) -> ViewSetResult { ViewSetResult::new() }
}

#[paneweft::example(id = "subject.with-parameter", claims = ["C1"])]
fn with_parameter(count: u32) -> Subject {
    let _ = count;
    Subject
}

fn main() {}
