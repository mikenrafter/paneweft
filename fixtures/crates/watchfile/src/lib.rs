//! A fixture modelled on vigil's `WatchFile`: a status, a tick, a judge status and the retained events, where a failed save can
//! redeliver an event with the same `event_id` and different contents. `Event::summary` may contain log content and is never captured.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchStatus {
    Pending,
    Cancelled,
}

pub struct WatchFile {
    pub status: WatchStatus,
    pub tick: u64,
    pub judge_status: String,
    pub events: Vec<Event>,
}

pub struct Event {
    pub event_id: String,
    pub tick: u64,
    pub redelivered: bool,
    pub summary: String,
}

impl WatchFile {
    pub fn pending() -> WatchFile {
        WatchFile { status: WatchStatus::Pending, tick: 0, judge_status: "Idle".to_string(), events: Vec::new() }
    }

    pub fn finish_cancelled(&mut self, tick: u64) {
        self.status = WatchStatus::Cancelled;
        self.tick = tick;
    }

    pub fn record(&mut self, event_id: &str, tick: u64, redelivered: bool) {
        self.events.push(Event { event_id: event_id.to_string(), tick, redelivered, summary: "SECRET LOG LINE".to_string() });
    }
}

#[cfg(feature = "paneweft")]
mod instrumentation {
    use super::{Event, WatchFile};
    use paneweft::{Context, Inspectable, ViewMeta, ViewSetResult};

    impl Inspectable for Event {
        const PANEWEFT_TYPE_ID: &'static str = "vigil::watch::Event";
        fn views(&self, cx: &mut Context) -> ViewSetResult {
            const META: ViewMeta = ViewMeta { id: "event.details", title: "Event", question: "Which event is this, and was it redelivered?", component: "shape", priority: 10 };
            cx.label(&self.event_id);
            let mut details = cx.details();
            details.field("event_id", self.event_id.as_str());
            details.field("tick", self.tick);
            details.field("redelivered", self.redelivered);
            let mut set = ViewSetResult::new();
            set.push(META, details.finish());
            set
        }
    }

    #[paneweft::views(type_id = "vigil::watch::WatchFile")]
    impl WatchFile {
        #[paneweft::view(id = "watch.status", title = "Status", component = "shape", priority = 10, question = "What state did this watch reach?")]
        fn status_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
            let mut details = cx.details();
            details.field("status", format!("{:?}", self.status));
            details.field("tick", self.tick);
            details.field("judge status", self.judge_status.as_str());
            details.field("event count", self.events.len());
            details.finish()
        }

        #[paneweft::view(id = "watch.events", title = "Events", component = "list", priority = 20, question = "Which events were retained, and were they redelivered?")]
        fn events_view(&self, cx: &mut paneweft::Context) -> paneweft::ViewResult {
            let mut table = cx.table().text_column("event", "Event").number_column("tick", "Tick").boolean_column("redelivered", "Redelivered").order_by("event", paneweft::Ascending);
            for (index, event) in self.events.iter().enumerate() {
                let target = cx.reference_keyed(event, &event.event_id)?;
                table.row(paneweft::Row::new(format!("event-{index}")).cell("event", event.event_id.as_str()).cell("tick", event.tick).cell("redelivered", event.redelivered).target(target));
            }
            table.finish()
        }
    }
}

#[cfg(all(test, feature = "paneweft"))]
mod tests {
    use super::*;

    paneweft::test_adapter!();

    #[paneweft::example(id = "watch.pending", claims = ["VW1"])]
    fn watch_pending() -> WatchFile {
        let watch = WatchFile::pending();
        paneweft::check_eq!("VW1", watch.status, WatchStatus::Pending);
        watch
    }

    #[paneweft::example(id = "watch.cancelled", claims = ["VW2", "VW2-empty"])]
    fn watch_cancelled() -> WatchFile {
        let mut watch = watch_pending();
        watch.finish_cancelled(7);
        paneweft::check_eq!("VW2", watch.status, WatchStatus::Cancelled);
        paneweft::check!("VW2-empty", watch.events.is_empty());
        watch
    }

    #[paneweft::example(id = "watch.redelivered", claims = ["VW3"])]
    fn watch_redelivered() -> WatchFile {
        let mut watch = watch_cancelled();
        watch.record("e-1", 3, false);
        watch.record("e-1", 6, true);
        paneweft::check_eq!("VW3", watch.events.len(), 2);
        watch
    }
}
