//! D1 (consolidation), Rust: every byte a capture emits passes one bounded serializer, so the emitted size is a property of that one path.
//! The same scenarios as packages/paneweft-ts/src/emission.test.ts. What is measured is the document the SDK writes: the bytes of the JSON
//! text of the whole graph. `collection_bytes` bounds that document; `root_bytes` bounds the objects, views and stored pages of one root.
mod support;
use paneweft::{Capture, CaptureOptions, Context, Inspectable, Limits, Row, Value, ViewMeta, ViewSetResult};
use serde_json::Value as Json;
use support::default_limits;

#[derive(Clone, Default)]
struct Spec {
    label: String,
    fields: Vec<(String, Value)>,
    detail: Vec<(String, Value)>,
    children: Vec<(String, Option<String>, Spec)>,
    columns: Vec<(String, String)>,
    rows: Vec<(String, Vec<(String, Value)>)>,
}

const DETAILS: ViewMeta = ViewMeta { id: "node.details", title: "Node", question: "What is this node?", component: "shape", priority: 1 };
const ROWS: ViewMeta = ViewMeta { id: "node.rows", title: "Rows", question: "Which rows?", component: "list", priority: 2 };

impl Inspectable for Spec {
    const PANEWEFT_TYPE_ID: &'static str = "t::Node";
    fn views(&self, cx: &mut Context) -> ViewSetResult {
        let mut set = ViewSetResult::new();
        set.run(cx, DETAILS, |cx| {
            cx.label(&self.label);
            for (name, value) in &self.fields {
                cx.field(name, value.clone());
            }
            let mut details = cx.details();
            for (name, value) in &self.detail {
                details.field(name, value.clone());
            }
            for (name, key, child) in &self.children {
                cx.reference_full(name, key.as_deref(), child)?;
            }
            details.finish()
        });
        set.run(cx, ROWS, |cx| {
            if self.columns.is_empty() {
                return Ok(paneweft::View::unsupported("no columns"));
            }
            let mut table = cx.table();
            for (key, title) in &self.columns {
                table = table.text_column(key, title);
            }
            for (id, cells) in &self.rows {
                let mut row = Row::new(id.clone());
                for (key, value) in cells {
                    row = row.cell(key, value.clone());
                }
                table.row(row);
            }
            table.finish()
        });
        set
    }
}

fn bytes(json: &Json) -> usize { json.to_string().len() }

thread_local! {
    /// Set by `publish`: whether the final measure had to replace the document (a defect: the ledger and the measure disagree).
    static EMERGENCY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
fn emergency() -> bool { EMERGENCY.with(std::cell::Cell::get) }

fn publish(roots: &[Spec], change: impl FnOnce(&mut Limits)) -> Json {
    let mut limits = default_limits();
    change(&mut limits);
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    for root in roots {
        capture.publish(root).expect("publishes");
    }
    let graph = capture.finish();
    EMERGENCY.with(|flag| flag.set(graph.emergency()));
    graph.to_json()
}

fn index(id: &Json) -> u64 { id.as_str().expect("an id")[1..].parse().expect("o<number>") }

/// The bytes of one root's records: its objects, its views and its stored pages (the ids of the objects between this root and the next).
fn root_spans(graph: &Json) -> Vec<usize> {
    let starts: Vec<u64> = graph["roots"].as_array().unwrap().iter().map(index).collect();
    let part = |name: &str, owner: &str, start: u64, end: u64| -> usize {
        let kept: Vec<Json> = graph[name].as_array().unwrap().iter().filter(|item| { let at = index(&item[owner]); at >= start && at < end }).cloned().collect();
        // the records of a list and the commas between them; the brackets of the list belong to the frame of the document
        bytes(&Json::Array(kept)) - 2
    };
    starts.iter().enumerate().map(|(at, start)| {
        let end = starts.get(at + 1).copied().unwrap_or(u64::MAX);
        part("objects", "id", *start, end) + part("views", "objectId", *start, end) + part("pages", "objectId", *start, end)
    }).collect()
}

// ---- seeded adversarial generation -----------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 { (self.next() >> 11) as f64 / (1u64 << 53) as f64 }
    fn between(&mut self, low: usize, high: usize) -> usize { low + (self.next() % (high - low + 1) as u64) as usize }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T { &items[self.between(0, items.len() - 1)] }
}

// units that JSON escapes (NUL, quote, backslash, newline, DEL), that take 2, 3 and 4 UTF-8 bytes, and plain ASCII
const UNITS: [&str; 17] = ["a", "b", "0", " ", "\u{0}", "\u{1}", "\"", "\\", "\n", "\u{7f}", "é", "€", "\u{2028}", "😀", "…", "$paneweft", "__proto__"];

/// A name or a string: mostly short, sometimes a thousand characters or more. `huge` allows the strings of tens of thousands (values, not keys:
/// a wide map of huge keys is megabytes of text that the unbounded reference run has to hold twice).
fn text_of(rng: &mut Rng, shortest: usize, longest: usize, huge: bool) -> String {
    let roll = rng.unit();
    let length = if roll < 0.03 { rng.between(1000, 3000) } else if huge && roll < 0.05 { rng.between(20_000, 60_000) } else { rng.between(shortest, longest) };
    let heavy = *rng.pick(&UNITS);
    let mut out = String::new();
    let mut count = 0;
    while count < length {
        let unit = if rng.unit() < 0.6 { heavy } else { rng.pick(&UNITS) };
        count += unit.chars().count();
        out.push_str(unit);
    }
    out
}

thread_local! {
    /// A capture holds at most this many generated values, so the unbounded reference run of the property stays a few megabytes.
    static NODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn text(rng: &mut Rng, shortest: usize, longest: usize) -> String { text_of(rng, shortest, longest, true) }
fn short(rng: &mut Rng, shortest: usize, longest: usize) -> String { text_of(rng, shortest, longest, false) }

fn value(rng: &mut Rng, depth: usize) -> Value {
    let roll = rng.unit();
    let left = NODES.with(|nodes| { nodes.set(nodes.get().saturating_sub(1)); nodes.get() });
    if depth >= 5 || roll < 0.35 || left == 0 {
        return match rng.between(0, 9) {
            0 => Value::Null,
            1 => Value::Bool(rng.unit() < 0.5),
            2 => Value::Int(rng.between(0, 2000) as i128 - 1000),
            3 => Value::Int(1_000_000_000_000_000_000_000_000i128 + rng.between(0, 1000) as i128),
            4 => Value::Bytes(vec![7u8; rng.between(0, 20_000)]),
            5 => Value::redacted(&text(rng, 0, 40)),
            6 => Value::Unsupported(text(rng, 0, 40)),
            7 => Value::Absent,
            _ => Value::Str(text(rng, 0, 40)),
        };
    }
    let width = left.min(if rng.unit() < 0.05 { rng.between(3000, 20_000) } else { rng.between(0, 12) });
    if roll < 0.65 {
        Value::List((0..width).map(|_| value(rng, depth + 1)).collect())
    } else {
        Value::Map((0..width).map(|_| (short(rng, 0, 20), value(rng, depth + 1))).collect())
    }
}

fn spec(rng: &mut Rng, depth: usize) -> Spec {
    let mut node = Spec { label: text(rng, 0, 40), ..Spec::default() };
    node.fields = (0..rng.between(0, 6)).map(|_| (short(rng, 0, 30), value(rng, 0))).collect();
    for at in 0..rng.between(0, 5) {
        let name: String = format!("{}#{at}", text(rng, 1, 30).chars().take(100).collect::<String>());
        node.detail.push((name, value(rng, 2)));
    }
    if depth < 4 {
        node.children = (0..rng.between(0, 3)).map(|_| (text(rng, 1, 30), if rng.unit() < 0.5 { Some(text(rng, 0, 40)) } else { None }, spec(rng, depth + 1))).collect();
    }
    if rng.unit() < 0.7 {
        node.columns = (0..rng.between(1, 3)).map(|at| (format!("{}@{at}", text(rng, 1, 20).chars().take(100).collect::<String>()), text(rng, 1, 30).chars().take(200).collect::<String>())).collect();
        let rows = if rng.unit() < 0.1 { rng.between(300, 800) } else { rng.between(0, 40) };
        let columns = node.columns.clone();
        node.rows = (0..rows).map(|at| {
            let cells = columns.iter().map(|(key, _)| (key.clone(), if rng.unit() < 0.7 { Value::Str(short(rng, 0, 40)) } else { Value::from(rng.between(0, 99)) })).collect();
            (format!("{}~{at}", short(rng, 0, 20).chars().take(90).collect::<String>()), cells)
        }).collect();
    }
    node
}

fn nul(unit: &str) -> String { unit.repeat(1500) }

fn probes(nul: &str) -> Vec<(&'static str, Spec)> {
    let short: String = nul.chars().take(120).collect();
    vec![
        ("a field name", Spec { fields: vec![(nul.to_string(), Value::from(1))], ..Spec::default() }),
        ("a map key", Spec { fields: vec![("m".into(), Value::Map(vec![(nul.to_string(), Value::from(1))]))], ..Spec::default() }),
        ("a detail name", Spec { detail: vec![(short.clone(), Value::from(1))], ..Spec::default() }),
        ("an edge name", Spec { children: vec![(nul.to_string(), None, Spec::default())], ..Spec::default() }),
        ("a domain key", Spec { children: vec![("c".into(), Some(nul.to_string()), Spec::default())], ..Spec::default() }),
        ("a label", Spec { label: nul.to_string(), ..Spec::default() }),
        ("a column key and a row id", Spec { columns: vec![(short.clone(), "T".into())], rows: vec![(short.clone(), vec![(short.clone(), Value::Str(nul.to_string()))])], ..Spec::default() }),
        ("a string value", Spec { fields: vec![("s".into(), Value::Str(nul.to_string()))], ..Spec::default() }),
    ]
}

// why: D1 / S2 (round 3). A name of 1,500 NUL characters passed a check of its raw length (1,500 < 4,096) and was then charged as the JSON
// text it becomes (6 bytes per NUL). Rejects every implementation that decides "fits" from a length of the input instead of the bytes of
// the output.
// proves: CLAIM(D1-emitted-bytes)
#[test]
fn escaped_names_and_values_of_1500_characters_stay_inside_collection_bytes() {
    for unit in ["\u{0}", "\"", "😀", "\\"] {
        for (what, node) in probes(&nul(unit)) {
            let graph = publish(&[node], |l| l.collection_bytes = 4096);
            assert!(!emergency(), "{what} of 1,500 {unit:?}: the ledger and the measure agree");
            assert!(bytes(&graph) <= 4096, "{what} of 1,500 {unit:?}: emitted {} bytes", bytes(&graph));
        }
    }
}

// why: D1. The property over seeded adversarial inputs: the document never exceeds collection_bytes, no root exceeds root_bytes, and
// whenever the unbounded document would have been bigger the bounded one says it is partial. Rejects a design in which each helper does
// its own accounting: some helper always forgets one kind of byte.
// proves: CLAIM(D1-emitted-bytes)
#[test]
fn the_emitted_document_holds_collection_bytes_root_bytes_and_the_partial_mark() {
    for seed in 1..=80u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        NODES.with(|nodes| nodes.set(1500));
        let roots: Vec<Spec> = (0..rng.between(1, 3)).map(|_| spec(&mut rng, 0)).collect();
        let collection = rng.between(4096, 70_000) as u64;
        let root = if rng.unit() < 0.4 { rng.between(1500, 40_000) as u64 } else { 2 * 1024 * 1024 };
        let string = *rng.pick(&[64u64, 512, 4096, 16 * 1024]);
        let page_rows = *rng.pick(&[1u32, 3, 10, 100]);
        let graph = publish(&roots, |l| { l.collection_bytes = collection; l.root_bytes = root; l.string_bytes = string; l.page_rows = page_rows; });
        let unbounded = publish(&roots, |l| { l.collection_bytes = 1 << 40; l.root_bytes = 1 << 40; l.string_bytes = string; l.page_rows = page_rows; });
        let where_ = format!("seed {seed}: collection {collection} root {root} string {string} pageRows {page_rows}");
        assert!(bytes(&graph) as u64 <= collection, "{where_}: emitted {} bytes", bytes(&graph));
        assert!(!emergency(), "{where_}: the ledger and the measure agree");
        for span in root_spans(&graph) {
            assert!(span as u64 <= root, "{where_}: a root holds {span} bytes (spans {:?}, roots {}, objects {}, views {}, pages {}, diagnostics {})", root_spans(&graph), graph["roots"], graph["objects"].as_array().unwrap().len(), graph["views"].as_array().unwrap().len(), graph["pages"].as_array().unwrap().len(), graph["diagnostics"].as_array().unwrap().len());
        }
        let would_cut = bytes(&unbounded) as u64 > collection || root_spans(&unbounded).iter().any(|span| *span as u64 > root);
        if would_cut {
            assert_eq!(graph["completeness"]["status"], "partial", "{where_}: a cut is marked");
        }
    }
}

// why: D1. A page body is part of what the capture emits. Thousands of rows with escaped cells spread over hundreds of stored pages are
// charged as the page records they become, and the rows that do not fit are counted as dropped.
// proves: CLAIM(D1-emitted-bytes)
#[test]
fn stored_page_bodies_are_charged_with_their_frames() {
    let rows = (0..3000).map(|at| (format!("r{at}"), vec![("c".to_string(), Value::Str("\u{0}\"\\".repeat(10)))])).collect();
    let node = Spec { columns: vec![("c".into(), "C".into())], rows, ..Spec::default() };
    let graph = publish(&[node], |l| { l.collection_bytes = 20_000; l.page_rows = 2; });
    assert!(bytes(&graph) <= 20_000, "emitted {} bytes", bytes(&graph));
    let view = graph["views"].as_array().unwrap().iter().find(|v| v["viewId"] == "node.rows").expect("the rows view");
    assert_eq!(view["completeness"]["status"], "partial");
    let kept = view["rowsTotal"].as_u64().unwrap();
    assert_eq!(view["completeness"]["omitted"]["rows"]["count"].as_u64().unwrap(), 3000 - kept);
    let stored: usize = graph["pages"].as_array().unwrap().iter().map(|p| p["rows"].as_array().unwrap().len()).sum();
    assert_eq!(stored + view["data"]["rows"].as_array().unwrap().len(), kept as usize);
}

// why: D1. A bound that cannot hold even the empty document is not silently ignored: the capture is empty, says which bound refused it,
// and the host (which measures the same document) is the one that refuses it.
// proves: CLAIM(D1-emitted-bytes)
#[test]
fn an_empty_marked_graph_is_emitted_when_collection_bytes_is_below_the_size_of_an_empty_graph() {
    let graph = publish(&[Spec { fields: vec![("x".into(), Value::from(1))], ..Spec::default() }], |l| l.collection_bytes = 200);
    assert_eq!(graph["objects"].as_array().unwrap().len(), 0);
    assert_eq!(graph["roots"].as_array().unwrap().len(), 0);
    assert_eq!(graph["completeness"]["status"], "partial");
    assert!(graph["completeness"]["omitted"]["collectionBytes"]["count"].as_u64().unwrap() > 0);
}

// why: D1. The text the SDK writes is the text it counted: the graph hands out the exact bytes of the document, and its size is what a
// reader of the file sees. No fallback fires for a document that fits.
// proves: CLAIM(D1-emitted-bytes)
#[test]
fn the_graph_hands_out_the_exact_emitted_text_and_its_size() {
    let mut limits = default_limits();
    limits.collection_bytes = 8192;
    let mut capture = Capture::new(CaptureOptions { limits, ..CaptureOptions::default() });
    capture.publish(&Spec { fields: vec![("a".into(), Value::Str("é€😀\u{0}".into()))], ..Spec::default() }).expect("publishes");
    let graph = capture.finish();
    assert_eq!(graph.text(), graph.to_json().to_string());
    assert_eq!(graph.bytes() as usize, graph.text().len());
    assert!(graph.bytes() <= 8192);
    assert!(!graph.emergency());
}
