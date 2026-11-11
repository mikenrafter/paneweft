pub struct Thing;

mod one {
    use super::Thing;
    #[paneweft::views(type_id = "dup::Thing")]
    impl Thing {
        #[paneweft::view(id = "thing.shared-id", title = "One", component = "shape", priority = 10, question = "First?")]
        fn first(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult { cx.details().finish() }
    }
}

mod two {
    pub struct Other;
    #[paneweft::views(type_id = "dup::Other")]
    impl Other {
        #[paneweft::view(id = "thing.shared-id", title = "Two", component = "shape", priority = 10, question = "Second?")]
        fn second(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult { cx.details().finish() }
    }
}

#[cfg(test)]
mod tests {
    paneweft::test_adapter!();
}
