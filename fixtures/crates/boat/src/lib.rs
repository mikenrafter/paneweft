//! A boat with a crew. The scaffold compile check appends a generated example to the end of this file.

pub struct Boat {
    pub name: String,
    pub crew: u32,
}

impl Boat {
    pub fn new(name: &str, crew: u32) -> Boat {
        Boat { name: name.to_string(), crew }
    }
}

#[cfg(feature = "paneweft")]
mod instrumentation {
    use super::Boat;

    #[paneweft::views(type_id = "boat::Boat")]
    impl Boat {
        #[paneweft::view(id = "boat.details", title = "Boat", component = "shape", priority = 10, question = "Which boat is this, and how many crew does it carry?")]
        fn details_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
            cx.label(&self.name);
            let mut details = cx.details();
            details.field("name", self.name.as_str());
            details.field("crew", self.crew);
            details.finish()
        }
    }
}
