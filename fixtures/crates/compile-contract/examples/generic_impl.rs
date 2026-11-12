// CONTRACT: `#[paneweft::views]` supports concrete types only (spec decision 4); the diagnostic says so.
struct Generic<T>(T);

#[paneweft::views(type_id = "contract::Generic")]
impl<T> Generic<T> {}

fn main() {}
