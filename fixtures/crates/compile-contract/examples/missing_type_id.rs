// CONTRACT: `#[paneweft::views]` requires type_id = "..."; the diagnostic names the attribute argument.
struct Untyped;

#[paneweft::views]
impl Untyped {}

fn main() {}
