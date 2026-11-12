//! A boat with a crew, and a test module of its own.

pub struct Boat {
    pub name: String,
    pub crew: u32,
}

impl Boat {
    pub fn new(name: &str, crew: u32) -> Boat {
        Boat { name: name.to_string(), crew }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_boat_keeps_its_name() {
        assert_eq!(Boat::new("Ada", 3).name, "Ada");
    }
}
