# Portable moldable components

Research and local source inspection: 2026-11-11. This is a design for a standalone tool. It has no dependency on diff-core. GT descriptions below come from the cited primary sources; the portable contracts, priorities, limits, and delivery schedule are proposals.

An agent asks a question about a codebase, gathers evidence with its existing tools, and submits a typed view. The tool checks the submission, renders it in a local browser, and returns a bounded answer with links for further inspection. A person or agent can give the same entity another view without changing its source language or framework.

The part worth carrying over from Glamorous Toolkit is the connection between a domain entity, its contextual tools, and the next question. A collection of unrelated diagram generators would miss that connection.

## 1. What GT actually supplies

Phlow describes inspector tabs and actions. A method marked `<gtView>` receives a builder and returns a view. GT discovers these methods on the object's class and its superclasses; method names such as `gtItemsFor:` are a convention, while the pragma is the discovery mechanism. A method can inspect its receiver and decline to supply content. The collector invokes the methods and attaches actions targeted at their views. [Phlow, undated][phlow]; [view collector, revision dated 2026-10-23][collector]; [CSV domain wrappers, undated][csv-model].

GT's documented basic builders are `list`, `columnedList`, `tree`, `columnedTree`, `textEditor`, `mondrian`, and `explicit`. The first four select collection members or children; the editor displays text; Mondrian builds a visualization; an explicit view embeds a custom element. These are view-building APIs, rather than interchangeable file formats. [Inspector views, undated][inspector-views].

The source also contains `details`, `diff`, `groupedList`, `table`, `text`, `composite`, `forward`, `empty`, `canvassable`, `pannable`, and `sparta`. Some are presentation decorators or composition mechanisms. They should not all become independent portable components. The inspected source revision is `3cfe58e18b7ead37a718cc52720bafdc1b6ac715`, committed 2026-10-23. [Phlow builder factories][factories].

| GT construct | What it does | Portable equivalent | What is lost |
|---|---|---|---|
| `<gtView>` method | Defines a contextual representation on a class | Register a view definition under an entity kind | Reflection over a live receiver and arbitrary Smalltalk computation |
| `list` / `columnedList` | Presents items, optionally with several columns | List/table of facts with stable row IDs | Lazy object streams and blocks computing cells against live objects |
| `tree` / `columnedTree` | Presents roots and computed children | Explicit parent/child occurrences with optional columns | Following arbitrary object references on demand |
| `forward` | Reuses a named view of another object | A registered alias to an entity/view pair | Direct message sends to the forwarded object |
| `textEditor` / `text` | Displays text with editor or text presentation | Anchored source excerpt or bounded text attachment | In-image evaluation and general editing unless separately implemented |
| `mondrian` | Builds nodes, edges, nesting, layouts, and interactions | Declarative graph with typed relations and fixed layout choices | Bloc stencils and arbitrary event behavior |
| `explicit` | Embeds a hand-built Bloc element | Later, a reviewed renderer plugin with a declared schema | Arbitrary live widgets supplied as executable code |
| `details` | Presents named properties | Data-shape/details preset | Property access computed from live state |
| `groupedList` / `table` | Supplies other collection presentations | Grouping and column presets of list | Exact GT widget behavior |
| `diff` | Supplies a text comparison view | Before/after component with separately pinned sides | GT's specific text and splitter implementation |
| `composite` | Combines subviews, typically as tabs | Several registered views for one entity | Automatic composition from image objects |
| `canvassable` / `pannable` / `sparta` | Adds graphical presentation or drawing support | Renderer-internal viewport and drawing options | Direct access to GT's graphics stack |
| `empty` | Supplies no displayed content, including overriding a view | Explicit applicability result or unsupported result | Silent omission is deliberately replaced by an explanation |
| `title:` / `priority:` | Names and orders tabs | Definition title and numeric priority | Immediate reflection of edited methods |
| View-local actions and `<gtAction>` | Adds contextual operations | Typed actions on a view or entity | Running arbitrary methods against objects |
| Item context menu and `send:` | Offers item operations and chooses the object sent onward | Named item actions and explicit entity references | Navigation based on arbitrary returned objects |
| Moldable inspector and pager | Keeps connected object inspections in neighboring panes | Entity panes with an explicit navigation trail | Shared live object identity and spontaneous object creation |
| Spotter and `<gtSearch>` | Searches globally or within a domain context | Search registered entities, views, examples, and notebook claims | Search across an entire running image |
| Contextual playground | Evaluates code bound to the inspected object | Scoped queries over a snapshot; optional external runner later | Uniform `self`, access to slots, and live mutation |
| Lepiter pages and snippets | Composes linked prose, code, examples, and rich content | Notebook/story containing typed blocks and evidence links | Shared live variables and multi-language execution sessions |
| `<gtExample>` | Produces a tested, inspectable example object | Named scenario with assertions and an inspectable result bundle | Retaining the returned live object after execution |
| Coder extensions | Adds contextual tools while editing source | Inspect a symbol, diagnostic, or source range using the same registry | Integrated editing, refactoring, and in-image compilation |
| Debugger and moldable exceptions | Installs domain tools for execution or exception context | Inspect an exception, stack snapshot, or recorded event as an entity | Stepping, resuming, and changing a running process |

The extra factory rows follow the inspected builder source. `details` also has a documented migration from key/value columned lists. Forwarding is demonstrated by exposing a wrapped object's existing view. [Builder factories][factories]; [Details migration, undated][details]; [CSV domain wrappers][csv-model].

GT gives views titles and numeric priorities. Lower values place tabs farther left; the inspected base view defaults to 50. A view can add its own refresh button or other actions. Independent `<gtAction>` methods can target a particular view. Item menus can inspect an association, its key, or its value; `send:` determines which value navigation opens. [Base view source, 2026-10-23][base-view]; [view collector][collector]; [CSV domain wrappers][csv-model].

Mondrian works directly with Bloc graphical elements. Its examples combine nested nodes, declaratively constructed edges, layouts, and hover behavior. The portable graph below introduces an explicit JSON graph model, which is a design change: current Mondrian builds a scene rather than requiring that intermediate model. [Mondrian, undated][mondrian]; [Mondrian and Bloc, undated][mondrian-bloc]; [Mondrian tutorial, undated][mondrian-examples].

In the inspector, a selected or explicitly inspected value can spawn an adjacent pane. Each pane offers different views of its object. The contextual playground can compute a new result and inspect that result in another pane. Spotter supports global searches and context-restricted searches; a domain object can define `<gtSearch>` methods. The portable version must encode both object references and navigation events explicitly. [The Moldable Inspector, Onward! 2015-10-25 to 2015-10-30][inspector-paper]; [Contextual Playground, undated][playground]; [GT tour, undated][tour]; [REST API case study, undated][rest].

Lepiter is a database of linked notebook pages assembled from snippets. Snippet kinds include prose, Pharo, JavaScript, Python, examples, and richer widgets such as Wardley maps. Pages and snippets have their own extensibility. The portable notebook keeps composition and links; execution requires a separate adapter and lifecycle. [Lepiter overview, undated][lepiter]; [Lepiter snippets, undated][snippets].

An example is a test that also returns its fixture for inspection or reuse. That property is the portable requirement, rather than the spelling of `<gtExample>`. Coder and debugger contextual tools use the same moldable principle; moldable exceptions carry domain context used to adapt the debugger. Snapshot inspection preserves that context, while execution control needs runtime-specific machinery. [Example-driven development, 2024-08-31][examples-paper]; [Moldable Tool, undated][moldable-tool]; [Moldable Exceptions, 2024-08-31][exceptions].

### The 2024 pattern vocabulary

Nierstrasz and Gîrba's preprint names fifteen patterns. Tooling: Moldable Tool, Contextual Playground, Custom View, Custom Search, Custom Action, Composed Narrative. Modeling: Moldable Object, Example Object, Moldable Data Wrapper, Moldable Collection Wrapper. Process: Project Diary, Tooling Buildup, Blind Spot, Simple View, Throwaway Analysis Tool. The current book uses Contextual View, Contextual Search, and Contextual Action where the preprint says Custom. Preserve that naming distinction when citing the two sources. [Moldable Development Patterns, 2024-09-27][patterns-paper]; [book pattern overview, undated][patterns-book].

Their consequences for this port are design judgments. An entity is the Moldable Object; imported records and typed result collections are its wrappers. A registered view, action, or search packages an investigation. An example makes it repeatable. A notebook retains the Project Diary and Composed Narrative. Simple View and Throwaway Analysis Tool mean a one-question view should be cheap to submit. Tooling Buildup means retaining useful definitions. Blind Spot means recording a question the current evidence cannot answer. These patterns survive serialization, although their live programming experience does not.

GT already demonstrates part of this portability. Phlow for Python defines decorated methods returning list, columned-list, text-editor, columned-tree, and forwarding views, including an empty result. Its documentation says ordinary trees can be emulated with one-column columned trees. This is a precedent for declarative cross-process views, not proof of full live-runtime parity. [Phlow for Python, undated][python-phlow].

## 2. Component catalogue

The order reflects likely usefulness during code comprehension. There are thirteen components. A preset chooses how an existing renderer answers a domain question; it does not introduce another rendering engine. State machines, boundaries, diffs, and risk displays below are portable proposals built from GT ancestors. They are not claimed as exact GT view-builder names.

### Shared item notation

These compact TypeScript shapes describe the intended JSON Schema contracts. Section 4 defines the envelope around each `data` payload. IDs are opaque strings within a snapshot. Line ranges are one-based and inclusive. Source IDs resolve through the envelope's `sources` array.

```ts
type Provenance = "read" | "parsed" | "compiled" | "observed" | "inferred";
type Scalar = string | number | boolean | null;
type Anchor = { repository: string; path: string; lines: [number, number] };
type EntityRef = { repository: string; id: string; kind: string };
type EvidenceTarget = string | { viewId: string; itemId: string };
type Item = {
  id: string;
  label?: string;
  anchor?: Anchor;
  evidence: string[];                 // nonempty source IDs
  entity?: EntityRef;                  // selection opens this entity
} & (
  | { provenance: Exclude<Provenance, "inferred"> }
  | { provenance: "inferred"; reason: string; basis: string[] }
);
type Column = { key: string; title: string; format: "text" | "number" | "boolean" };
```

An inferred item also requires `reason: string` and `basis: string[]` referencing supporting item or source IDs. `observed` requires a source with a run ID. `compiled` identifies the compiler or language-service invocation. Provenance describes how a claim was obtained, not a confidence score. Conflicting claims remain separate items with a conflict link.

All examples below show only `data`. They use illustrative source IDs and deliberately tiny fixtures; each is wrapped by the common envelope before submission. The real-codebase demo in section 6 distinguishes inspected facts from scenarios still needing execution.

Every renderer provides filtering, focus, selection-to-open-an-entity, and source click-through when the corresponding references exist. It exposes a named item action menu to keyboard users as well as pointer users. An item without an entity or anchor shows that absence; clicking it must not invent a target. Expansion is specific to components with nested or clipped content.

### 1. List and columned list

Question: "What is in this set, and which members matter?" Direct GT ancestors are `list` and `columnedList`. Pick it for symbols, diagnostics, test outcomes, changed files, or a ranked investigation queue. Use one column for a plain list. Avoid it when parentage or paths between items answer the question.

```ts
type ListData = {
  columns: Column[];
  rows: Array<Item & { cells: Record<string, Scalar>; group?: string }>;
  order: { key: string; direction: "asc" | "desc" };
};
```

Interactions include stable sorting, column filters, grouping, expanding clipped cells, focusing a row, and opening its entity in the next pane. The bounded form returns column names, matching/total counts, current ordering, selected rows, and omitted-row count with a cursor.

```json
{"columns":[{"key":"name","title":"Module","format":"text"}],"rows":[{"id":"mcp","cells":{"name":"mcp.rs"},"provenance":"read","evidence":["s1"]}],"order":{"key":"name","direction":"asc"}}
```

### 2. Tree and columned tree

Question: "How is this entity composed?" Direct ancestors are `tree` and `columnedTree`. Pick it for directory structure, syntax, nested ownership, or a domain aggregate. Avoid turning a dependency graph into a tree unless you explicitly name the spanning relation and preserve back-references.

```ts
type TreeData = {
  columns: Column[];
  roots: string[];
  nodes: Array<Item & {
    cells: Record<string, Scalar>; children: string[];
    childrenState: "complete" | "not_loaded";
  }>;
};
```

Interactions expand/collapse, filter while retaining ancestor context, focus a subtree, and open a selected entity. Node IDs identify occurrences; repeated entities may have several occurrences. Structural cycles are rejected. `not_loaded` produces a visible load/needs-evidence affordance, not a leaf. Text returns indented paths, expansion state, child counts, and named unexpanded or unloaded branches.

```json
{"columns":[{"key":"name","title":"Name","format":"text"}],"roots":["r"],"nodes":[{"id":"r","cells":{"name":"src"},"children":["c"],"childrenState":"complete","provenance":"read","evidence":["s1"]},{"id":"c","cells":{"name":"mcp.rs"},"children":[],"childrenState":"complete","provenance":"read","evidence":["s1"]}]}
```

### 3. Dependency and call/flow graph

Question: "What connects these entities, and by which relation?" Ancestor: Mondrian. Pick it for imports, resolved calls, data flow, or paths between named endpoints. Avoid a repository-wide graph when a bounded neighborhood answers the question. An import does not establish a call; an observed call does not establish every possible call.

```ts
type GraphData = {
  nodes: Array<Item & { group?: string }>;
  edges: Array<Item & { from: string; to: string; relation: string }>;
  layout: "layered" | "grid";
  focus?: { node: string; direction: "in" | "out" | "both"; depth: number };
  paths?: Array<{ id: string; edgeIds: string[] }>;
};
```

Interactions filter relation and provenance, expand a declared neighborhood, focus a path, and select nodes or edges to open their entities or evidence. Cycles remain visible. Text returns adjacency tuples and explicitly selected paths, with counts and omitted neighborhoods. It never claims reachability beyond the submitted graph.

```json
{"nodes":[{"id":"a","label":"MCP","provenance":"read","evidence":["s1"]},{"id":"b","label":"Engine","provenance":"read","evidence":["s1"]}],"edges":[{"id":"e","from":"a","to":"b","relation":"invokes","provenance":"read","evidence":["s1"]}],"layout":"layered","paths":[{"id":"p","edgeIds":["e"]}]}
```

### 4. Annotated source excerpt

Question: "Which exact code supports this statement?" Ancestor: `textEditor`, with the contextual highlighter idea from Coder. Pick it to explain a branch, boundary check, or error path. Avoid pasting whole files or using a highlighted excerpt as proof that an entire system has a property.

```ts
type SourceData = {
  excerpt: Item & { anchor: Anchor; language: string; text: string };
  annotations: Array<Item & { lines: [number, number]; message: string; claimIds: string[] }>;
};
```

Interactions focus an annotation, expand only within stored source bounds, filter claim IDs, and open the source entity or referenced claim in the next pane. Lines retain file numbering. Text returns numbered excerpt lines and annotation-to-claim links; clipping reports omitted line ranges. If local bytes no longer match the recorded hash, click-through offers the stored excerpt and identifies the mismatch.

```json
{"excerpt":{"id":"x","anchor":{"repository":"r","path":"src/check.ts","lines":[4,4]},"language":"typescript","text":"if (!allowed) return denied;","provenance":"read","evidence":["s1"]},"annotations":[{"id":"a","lines":[4,4],"message":"Denial branch","claimIds":["C1"],"provenance":"read","evidence":["s1"]}]}
```

### 5. Data-shape and details view

Question: "What does this value or boundary payload contain?" Ancestors: `details`, columned trees, and domain wrappers. Pick it for configuration, JSON messages, compiler types, schema variants, or bounded runtime values. Avoid presenting one observed object as a complete type definition.

```ts
type ShapeData = {
  basis: "declared" | "observed";
  root: string;
  fields: Array<Item & {
    path: string; type: string; presence: "required" | "optional" | "unknown";
    example?: Scalar; children: string[]; ref?: string;
  }>;
};
```

Interactions expand fields, compare declared and observed views through links, filter optional/unknown fields, and open a field's symbol or source. Recursive types use `ref`, not infinite expansion. Text returns field paths, types, presence, basis, and references. Missing, null, and redacted examples are distinct; redaction is a source note, not the scalar string pretending to be a value.

```json
{"basis":"declared","root":"f","fields":[{"id":"f","path":"watch_id","type":"string","presence":"required","children":[],"provenance":"read","evidence":["s1"]}]}
```

### 6. Notebook/story

Question: "How do the evidence and views answer this investigation?" Ancestors: Lepiter, Project Diary, and Composed Narrative. Pick it to preserve reasoning, unanswered questions, and a route through views. Avoid letting prose turn unsupported conclusions into established facts.

```ts
type NotebookBlock = Item & (
  | { kind: "prose"; markdown: string }
  | { kind: "view"; viewId: string }
  | { kind: "claim"; statement: string; status: "supported" | "disputed" | "open";
      supports: EvidenceTarget[]; contradicts: EvidenceTarget[] }
  | { kind: "example"; exampleId: string }
);
type NotebookData = { blocks: NotebookBlock[] };
```

Interactions expand embedded views, filter claims by status, reorder blocks, follow evidence, and open entities in the inspector beside the page. Notebook editing creates a new page revision. Text returns ordered questions, claim status, referenced views/examples, named gaps, and omitted-block count. Embedded views return references rather than recursively flooding the reply.

```json
{"blocks":[{"id":"b1","kind":"prose","markdown":"Why does cancellation preserve a result?","provenance":"read","evidence":["s1"]},{"id":"b2","kind":"view","viewId":"delivery-path","provenance":"read","evidence":["s1"]}]}
```

### 7. Example

Question: "Can I rerun this scenario and inspect its tested result?" Ancestor: `<gtExample>` and Example Object. Pick it for a minimal bug reproduction, protocol exchange, or behavior demonstration. Avoid treating a test's exit code as an inspectable result, or a scenario without assertions as a tested example.

```ts
type ExampleData = {
  scenario: Item & { runnerId: string; parameters: Record<string, Scalar> };
  runs: Array<Item & {
    runId: string; status: "passed" | "failed" | "error";
    assertions: Array<Item & { statement: string; passed: boolean }>;
    result?: EntityRef; error?: string;
  }>;
};
```

A passed run requires at least one assertion, all passing, and a result entity present in its output bundle. Failed assertions may still return an inspectable result; infrastructure errors explain why none exists. Interactions select runs, inspect results, filter assertions, and request a rerun through the local runner registry. Each run records inputs, command identity, revision, and output hash. Text returns status, assertion counts/failures, result reference, and a rerun instruction. An empty `runs` array says "not run".

```json
{"scenario":{"id":"once","label":"One change fires","runnerId":"vigil-one-write","parameters":{},"provenance":"read","evidence":["s1"]},"runs":[]}
```

### 8. State machine

Question: "Which states and transitions are legal?" Ancestors: a domain-specific Mondrian view and Example Object; this is a proposed preset. Pick it for lifecycle, protocol, retry, or cancellation rules. Avoid deriving a complete transition system from enum cases alone.

```ts
type StateData = {
  states: Array<Item & { initial: boolean; terminal: boolean }>;
  transitions: Array<Item & { from: string; to: string; trigger: string; guard?: string }>;
  trace?: { transitionIds: string[]; runId: string };
};
```

Interactions focus a state, expand outgoing transitions, filter guards, inspect a transition's source, and overlay a named observed trace. Text returns a transition table and trace IDs, separating declared/read rules from observed paths. Multiple initial states are allowed only when the scope explicitly models alternatives. Missing guards are unknown unless the source establishes an unconditional transition.

```json
{"states":[{"id":"p","label":"pending","initial":true,"terminal":false,"provenance":"read","evidence":["s1"]},{"id":"f","label":"fired","initial":false,"terminal":true,"provenance":"read","evidence":["s1"]}],"transitions":[{"id":"t","from":"p","to":"f","trigger":"change detected","provenance":"read","evidence":["s1"]}]}
```

### 9. Sequence/timeline

Question: "In what order did work cross these participants?" Ancestors: custom Mondrian or explicit views over domain events. Pick it for request paths, async handoffs, build phases, or recorded traces. Avoid implying causation from wall-clock ordering or presenting an expected sequence as an observation.

```ts
type SequenceData = {
  mode: "sequence" | "timeline";
  clock: "logical" | "monotonic_ms" | "utc_ms";
  lanes: Array<Item>;
  events: Array<Item & { lane: string; at: number; end?: number;
    toLane?: string; causes: string[] }>;
};
```

Interactions expand spans, filter lanes/events, focus a causal chain, and inspect event entities or source. Text returns ordered event tuples with units and explicit causal predecessors. Cross-process monotonic clocks need a shared run clock or named synchronization gaps. Duplicate timestamps use event ID for display order and remain concurrent unless a causal link says otherwise.

```json
{"mode":"sequence","clock":"logical","lanes":[{"id":"a","label":"client","provenance":"read","evidence":["s1"]},{"id":"b","label":"server","provenance":"read","evidence":["s1"]}],"events":[{"id":"e","label":"watch_create","lane":"a","toLane":"b","at":1,"causes":[],"provenance":"read","evidence":["s1"]}]}
```

### 10. Matrix

Question: "Where do two sets intersect, and where are the gaps?" Ancestors: columned-list/table views and custom explicit graphics; this is a proposed analytical preset. Pick it for module-to-module relations, requirement-to-test coverage, or input-to-handler support. Avoid a matrix for a sparse path question better served by a graph.

```ts
type MatrixData = {
  rows: Item[]; columns: Item[]; metric: string; unit: string;
  cells: Array<Item & { row: string; column: string; value: number | null }>;
  missing: "unknown" | "zero";
};
```

Interactions filter/reorder axes, focus a row/column or cell, expand cell evidence, and open the supporting relation or entity. Text returns axis labels and sparse tuples with units. `null` means unknown. Omitted cells mean zero only when `missing: "zero"` is justified by a complete scoped enumeration; otherwise they stay unknown. Sorting must preserve row and column identity.

```json
{"rows":[{"id":"r","label":"create","provenance":"read","evidence":["s1"]}],"columns":[{"id":"c","label":"MCP test","provenance":"read","evidence":["s1"]}],"metric":"supporting tests","unit":"count","cells":[{"id":"x","row":"r","column":"c","value":1,"provenance":"read","evidence":["s1"]}],"missing":"unknown"}
```

### 11. Layered boundary map

Question: "Which responsibilities and trust boundaries does a path cross?" Ancestors: nested Mondrian nodes and Moldable Data Wrapper; this is a proposed domain view. Pick it for browser/server/storage separation, process boundaries, or ports and adapters. Avoid asserting that folder names establish architectural enforcement.

```ts
type BoundaryData = {
  layers: Array<Item & { order: number }>;
  nodes: Array<Item & { layer: string }>;
  crossings: Array<Item & { from: string; to: string; relation: string;
    assessment: "allowed" | "violation" | "unknown"; ruleId?: string }>;
  rules: Array<Item & { statement: string }>;
};
```

Interactions expand a layer, filter crossings and assessments, focus a path, and open the rule or call-site entity. Text returns layer membership and crossing tuples with rule IDs. A violation requires a cited rule; absent policy yields unknown. Layout order is a display choice and carries no automatic permission semantics.

```json
{"layers":[{"id":"l","label":"transport","order":0,"provenance":"read","evidence":["s1"]}],"nodes":[{"id":"n","label":"MCP","layer":"l","provenance":"read","evidence":["s1"]}],"crossings":[],"rules":[]}
```

### 12. Before/after diff

Question: "What changed in this scoped representation?" Ancestor: Phlow `diff`, generalized to keyed records. Pick it for source, configuration, API fields, or scenario results. Avoid comparing observations with different scopes or treating an absent partial observation as a deletion.

```ts
type DiffData = {
  beforeSnapshot: string; afterSnapshot: string;
  mode: "text" | "records";
  changes: Array<Item & { key: string; operation: "add" | "remove" | "change";
    before?: Scalar; after?: Scalar; beforeAnchor?: Anchor; afterAnchor?: Anchor }>;
};
```

Interactions filter operations, expand stored context, focus a key/hunk, and open either revision's entity or source in the next pane. Text returns keyed changes and both snapshot IDs. Add/remove/change field requirements differ. Text mode uses line-keyed records with explicit hunks; v0 does not compute a semantic diff. Unknown baseline coverage produces an unresolved comparison gap, not fabricated removals.

```json
{"beforeSnapshot":"s-old","afterSnapshot":"s-new","mode":"records","changes":[{"id":"d","key":"timeout_s","operation":"change","before":10,"after":15,"provenance":"read","evidence":["s1","s2"]}]}
```

### 13. Risk/heat overlay

Question: "Where should I investigate next, according to a stated measure?" Ancestors: Mondrian stencils encoding values with visual properties; this is a proposed overlay. Pick it for measured churn, observed latency, uncovered requirements, or an explicitly reasoned risk hypothesis. Avoid using color or a single unexplained score as a verdict.

```ts
type HeatData = {
  baseViewId: string; metric: string; unit: string;
  method: string; domain: [number, number]; higherMeans: string;
  samples: Array<Item & { targetItemId: string; value: number | null }>;
};
```

Interactions adjust a declared threshold, filter unknowns, focus high/low values, expand the rationale, and open target entities. The overlay retains the base view's navigation. Text returns metric, method, unit, range, ranked values, and unknown count. Missing measurements stay unknown. Inferred risk requires a reason and basis on each sample; observed latency requires a run. Color has labels, patterns, or a numeric alternative.

```json
{"baseViewId":"modules","metric":"changed lines","unit":"lines","method":"git numstat over a declared revision interval","domain":[0,20],"higherMeans":"more change","samples":[{"id":"h","targetItemId":"mcp","value":12,"provenance":"read","evidence":["s1"]}]}
```

## 3. Inspector model

Use three separate concepts. A component is a reusable renderer plus its data contract. A view definition gives an entity kind a titled, prioritized use of a component. A view instance is a validated envelope containing facts about one entity at one snapshot.

```ts
type ViewDefinition = {
  id: string; entityKind: string; title: string; priority: number;
  component: string;
  requires: string[];                // named capabilities/data roles
  dataRole: string;                  // supplied dataset, no executable selector
  forward?: { entityId: string; viewDefinitionId: string };
};
type Entity = EntityRef & {
  snapshotId: string;
  label: string;
  dataRoles: string[];
  relations: Array<{ name: string; target: EntityRef }>;
};
```

Kinds describe domain meaning, such as `vigil/watch`, `vigil/delivery`, `code/module`, `residual/selection`, or `example/run`. They do not require implementing those classes in the analyzed language. A registry indexes definitions by exact kind. A `*` fallback supplies metadata and raw JSON. v0 has no kind inheritance or arbitrary executable applicability predicates. This replaces class-method discovery with explicit registration and named data availability.

For example, `vigil/watch` can register "Lifecycle" using the state preset, "Events" using list, "Definition" using source, and "Example" using example. Adding "Persistence failures" can be one registry entry pointing at another list dataset. Someone can submit a new instance with `render`, then save its definition with `register_view`. Reusing an existing component needs no frontend code. A genuinely new graphical grammar needs a renderer implementation and tests; GT's fully custom `explicit` equivalent comes later.

Definitions sort by ascending priority, then stable definition ID. Default priority is 50, following GT's base convention. The initial view is the first applicable one; a deep link or remembered explicit user choice takes precedence. View titles answer domain questions, such as "Calls receiving cancellation", rather than exposing renderer names. Two definitions using graph can coexist.

Applicability has a visible result: available, needs data with named missing roles, or unsupported with a reason. The inspector lists unavailable registered views in a collapsed "Needs evidence" section. A complete empty collection says "0 items within this scope". It is different from an unavailable view and from an extraction error.

Each pane stores `{entityRef, snapshotId, viewDefinitionId, selection, filters}`. Selecting an inspectable item opens the next pane with its target entity and applicable views. Ordinary selection replaces unpinned descendants; pinning retains a branch in history. Expansion and multi-selection are distinct controls so selecting a tree chevron does not navigate. Changing tabs preserves the entity and its valid selection. A narrow viewport shows one pane and a breadcrumb trail; history retains the others. Browser Back restores pane state.

Cross-view links address a snapshot, view instance, and optional item. They may request a preferred view, with a visible fallback if that view is unavailable. Missing references return an unresolved-target explanation. Cyclic entity relations are legal and tracked in history; forwarding aliases reject cycles. Navigation never silently mixes snapshots.

Spotter-style search indexes the submitted entities, view titles/questions, examples, notebook pages, and claims. A scope parameter restricts search to the current entity's submitted relations. Search results open inspectors using the same navigation path. It cannot search code that the agent has not supplied. The first contextual playground is a small filter/focus/query panel bound to this entity and snapshot. General code evaluation and live debugging require later adapters.

## 4. Shared envelope and bounded answers

```ts
type Completeness =
  | { status: "complete"; criterion: string }
  | { status: "partial"; gaps: Array<{ id: string; question: string; reason: string }> }
  | { status: "unsupported"; reason: string; missingCapabilities: string[] };
type Source = {
  id: string;
  kind: "file" | "command" | "log" | "document";
  repository?: string; path?: string; url?: string;
  sha256: string;
  capturedAt: string;
  method: string;                    // procedure, parser/compiler version, or read note
  runId?: string; argv?: string[]; exitCode?: number;
};
type EnvelopeBase = {
  schemaVersion: "paneweft.view/1";
  id: string; title: string; question: string;
  entity: EntityRef;
  snapshotId: string;
  component: string; viewDefinitionId: string;
  scope: { repositories: string[]; roots: string[]; excludes: string[];
    relation?: string; limits: string[] };
  sources: Source[];
  generatedAt: string;               // RFC 3339 UTC
  freshness: { repositories: Array<{
    id: string; root: string; gitRev: string | null; dirty: boolean;
    files: Record<string, string>;   // relative path -> SHA-256 of inspected bytes
  }> };
  links: Array<{ id: string; relation: string; snapshotId: string;
    viewId: string; itemId?: string; entity?: EntityRef }>;
};
type Envelope = EnvelopeBase & (
  | { completeness: Extract<Completeness, {status: "complete" | "partial"}>;
      data: ComponentData }           // component selects the matching data schema
  | { completeness: Extract<Completeness, {status: "unsupported"}>; data?: never }
);
type Bundle = {
  schemaVersion: "paneweft.bundle/1";
  entities: Entity[];
  definitions: ViewDefinition[];
  views: Envelope[];
};
```

Partial requires at least one named gap. Unsupported has no data body. Unsupported and partial are domain results, while malformed input, extraction failure, refusal, and transport failure are operation errors with codes. Errors have `{code, message, errors: [{pointer, constraint, hint}], retryable}`; failures without a field location use an empty errors array. The browser and agent response show the status and reason in either case. A complete claim always names its enumeration criterion, such as "all direct imports in the six listed files". Schema validation cannot prove that the criterion is truthful.

Bundle import registers entities, definitions, and views together after checking all references. This supplies the entity-registration path used by `render`, rather than relying on entities appearing implicitly when clicked. Single-envelope rendering requires its entity and definition to exist already. An entity ID is unique within its repository and snapshot; contradictory replacement data requires a new snapshot. Generic example results can be entities of kind `json/value` with an inspectable shape or raw view. Notebook claim supports and contradictions reference source IDs or `{viewId, itemId}` targets, never ambiguous bare item IDs across views.

File sources require repository and path; command/log sources identify the captured output and its digest; document sources identify a path or URL. Source anchors must resolve to a recorded file hash. Full repository freshness includes every file that supported the answer, including manifests and configuration used in extraction. Git revision alone cannot identify dirty bytes. Non-Git roots use `gitRev: null` and retain hashes. Reading several files while they change yields a named consistency gap unless the agent can pin their captured bytes together.

Freshness is computed separately from the evidence's completeness: fresh, stale with changed paths, or unknown with inaccessible roots. A complete historical view remains complete for its recorded snapshot. It can simultaneously be stale relative to today's checkout. Opening an old link keeps that snapshot. Refresh creates a new immutable snapshot and names its predecessor; it does not rewrite the old view.

The browser shows provenance badges on facts and a persistent completeness/freshness strip above each view. Collapsed notebook blocks still display their status. A view mixing read, compiled, and observed facts shows all of them. The returned text or JSON always includes those categories, coverage status, current filters, snapshot ID, and the question, even when zero rows match.

`render` and inspection calls accept `format: "text" | "json"` and `maxBytes`, default 8192, minimum 2048, maximum 32768. This limit covers the serialized business reply, including URLs, summaries, and any repeated MCP content, excluding protocol framing. The server measures UTF-8 bytes after serialization. It never slices serialized JSON or a UTF-8 code point. If a requested budget cannot fit the mandatory header, it returns a bounded `BUDGET_TOO_SMALL` error with the minimum.

Replies report `total`, `matched`, `returned`, `omitted`, `truncated`, and a continuation cursor when more content exists. Counts refer to the same filtered snapshot; visual collapse is separately reported. A cursor binds snapshot, filter, ordering, and position. It cannot be reused against a different query. Complete metadata stays addressable through paged getters. A short reply includes gap counts and at least the first named gap, with a cursor for the rest. It never replaces an unknown count with zero.

For list, for example, the readable body might be `1/6 matched rows returned; 5 omitted; mcp.rs -> code/module:mcp; read; s1`. The mandatory header supplies question, completeness, freshness, snapshot, and provenance categories. Graph text contains relation tuples, not generated interpretations of graph geometry. A notebook returns claim and view references rather than copies of every embedded result. Full source output is available only through explicit bounded expansion.

v0 accepts at most 2 MiB per view, 8 MiB per bundle, and 10,000 fact items per view; its graph budget is 200 nodes and 500 edges. Input checks cap nesting at 32 levels and strings at 64 KiB of UTF-8, with smaller schema bounds for IDs and labels. A notebook can reference other notebooks, but inline expansion stops after one level and exposes a link for deeper navigation. Oversize payloads fail with the applicable limit and a suggestion to scope or partition the view. They are never silently dropped by the renderer. Very large complete sets should be represented as a clearly scoped summary view with links to separately submitted detail views.

## 5. v0 architecture and one-week cut

Use a new standalone repository at `/home/mini/Documents/repos/paneweft`. The name is a working choice. The path was absent and an exact-name web search found no indexed match on 2026-11-11; this is a collision check, not a trademark claim. Do not create the repository as part of this read-only design task.

Use TypeScript for the core, CLI, MCP adapter, and browser. Use Node for the local process, plain DOM and SVG for presentation, and a bundled browser build with no CDN dependencies. The analyzed language remains unconstrained. Choose the implementation framework for maintenance convenience; none of its types appear in the submitted contracts. For the small v0 graphs, use a fixed grid or a layered layout that groups strongly connected nodes, orders groups and members by stable ID, and routes edges by a fixed rule. Font loading, viewport size, and layout version are pinned in structure goldens. There is no force simulation in v0.

JSON Schema draft 2020-12 is the single source for wire structures. Generate TypeScript declarations and example validation from it. Use Ajv's 2020-12 implementation with strict validation and format checks. Run semantic checks after schema checks for referential integrity, unique IDs, valid line ranges, contiguous paths, variant rules, and cycle constraints. Keep those checks in one core used by CLI and MCP. Ajv documents the separate 2020-12 class and the incompatibility of mixing schema drafts in one instance. [Ajv documentation, undated][ajv].

Store component IDs, schemas, example payloads, capabilities, and summary policies in a catalogue. Store view definitions separately by entity kind. Use canonical immutable JSON files plus a small manifest, without a database in v0. Content hashes identify snapshots and embedded assets. Keep ordered arrays ordered; canonicalize object keys and unordered lookup tables. Atomic manifest replacement prevents an interrupted notebook save from destroying the previous page revision. An explicit session directory owns data; stopping the server preserves it until the owner deletes or exports it. v0 offers JSON bundle export/import with schema-version checks.

One local server serves browser assets, view data, and anchored stored source excerpts over loopback. CLI and stdio MCP processes call the same core and the same running session through a private local endpoint. The browser reads validated view models, not repository paths or arbitrary HTML. Requesting a source anchor resolves only against the registered repository root and recorded snapshot. Store submitted excerpts by default; allowlisted additional source reads use canonical paths and reject traversal and symlink escape.

The trust boundary is an agent-submitted document rendered locally. Treat labels, source text, notebook Markdown, and URLs as data. Escape text; sanitize Markdown; forbid embedded scripts, raw event handlers, and arbitrary HTML renderers. Bind loopback, reject foreign browser origins for writes, and use an unguessable session credential. Notebook links cannot invoke shell commands. This addresses code and local-file exposure through the viewer without requiring a general sandbox for all agent activity.

Use the official TypeScript MCP server SDK for stdio. Adapt its advertised tool schemas from the canonical JSON Schema; if the high-level API requires a different schema representation, generate that adapter or use lower-level tool handlers. Do not hand-maintain an independent Zod contract. Log to stderr. SDK documentation explicitly reserves stdout for protocol messages. Pin the chosen SDK release in the new repo because its entry points have changed across major versions. [MCP stdio documentation, undated][mcp-sdk].

| Operation | Request and result |
|---|---|
| `list_components` | Optional capability filter and cursor; returns supported IDs and concise questions |
| `describe_component` | Component ID; returns schema, capabilities, limits, and one valid example, paged when needed |
| `validate` | Envelope or bundle; returns valid or errors with code, JSON pointer, expected constraint, and repair hint |
| `register_view` | Definition and expected registry revision; returns the new registry revision or a conflict |
| `render` | Envelope/bundle and summary budget; atomically stores it, returns local URL, IDs, validation notes, and bounded summary |
| `open_entity` | Session, snapshot, entity, optional preferred view; returns pane state, available views, and bounded answer |
| `navigate` | Pane and item/action ID; returns the next pane or a named unresolved target |
| `inspect_view` | View, filter/focus, format, cursor, budget; returns a bounded slice without creating a new snapshot |
| `search` | Query plus optional entity scope; returns bounded typed search results |
| `notebook_create`, `notebook_get`, `notebook_update` | Create/read a page; update ordered blocks using an expected page revision, with conflict errors |
| `example_record` | Scenario, run metadata, and result bundle; validates assertions and inspectable result references |

The CLI has corresponding commands, including `components`, `describe`, `validate`, `render --file`, `open`, `navigate`, `inspect`, `search`, `notebook`, and `example`. `paneweft serve --session DIR` starts the local viewer; `paneweft mcp --session DIR` exposes the same session over stdio. MCP discovery names remain short and stable. CLI and MCP produce the same error codes and summary contents.

Example reruns use an owner-configured local runner registry, kept outside submitted view documents. A runner has an ID, executable and argv template, workspace root, parameter schema, timeout, and output-bundle path. `paneweft example run ID` invokes it without a shell and imports the returned bundle. An agent can also run the documented recipe itself and call `example_record`. The browser and MCP v0 can request or describe a rerun but cannot install a runner or execute arbitrary argv from a payload. A Rust or TypeScript script can assert behavior and emit the same JSON result contract. General REPL sessions and remote object handles are later work.

### Components and work sequence

v0 supplies list/columned list, tree/columned tree, graph, annotated source, data shape as a tree/details preset, notebook/story, and example. The graph supports fixed layered/grid layout, relation filtering, and neighborhood focus. The notebook supports prose, claim, view, and example blocks. The example supports recorded results and explicit CLI reruns. v0 includes entity registration, priorities, pane navigation, cross-view links, search, completeness, freshness, and bounded replies. It has no built-in code extractor; the agent submits facts.

Later components are the state-machine preset with trace checking, sequence/timeline, matrix, layered boundary map, before/after diff, and heat overlay. State transitions can already be submitted as labeled v0 graphs, and event order as a v0 list. This makes the vigil demo possible without pretending the later specialized interactions exist. General renderer plugins, lazy extraction providers, live debugger control, collaborative notebooks, and semantic-diff computation are later work too.

Seven working days is a planning estimate for an agent with a reviewer, not a measured delivery promise. Day 1 defines schemas, literal fixtures, and red claims. Day 2 implements validation, immutable storage, summaries, and CLI. Day 3 adds inspector panes, list/tree/source, and source anchors. Day 4 adds deterministic graph layout and the shape preset. Day 5 adds notebook composition and example result import/rerun. Day 6 wires MCP, search, freshness, and parity checks. Day 7 exercises both demos, checks keyboard navigation, and reviews rendered-structure goldens. If this slips, defer the CLI runner and retain reproducible external recipes plus result import; do not cut provenance, unknown states, or navigation.

### Local reuse candidates

The inspected residual code now exists locally, unlike the unavailable snapshot noted in research note 03. `/home/mini/Documents/repos/residual-cli/src/view/mod.rs` builds a page and snapshot document and serves `/` plus `/snapshot.json` over loopback. `static_export.rs` inserts a compiled TypeScript bundle and escapes JSON before embedding it in the page. These are useful patterns for local serving, export, and safe data insertion. Reusing residual's Rust/Dioxus rendering stack would add a second implementation language to this v0; copy the small serving and export ideas after checking licenses, rather than depend on its domain model.

`web/src/nkp-landscape.ts` has persistent view handles and coordinates bundle, heatmap, and regions views with shared filters and selection. `landscape-selection.ts` separates pure selection logic from the DOM. Those boundaries and tests are useful references. Their `PendingState`, force/component/attractor keys, filtering semantics, D3 drawing code, and evolving simulation behavior need adaptation. They are not a language-agnostic component API. The current browser entry imports D3 from a CDN; the proposed viewer bundles dependencies locally.

`/home/mini/Documents/repos/phoe-nix/scout-modules/vigil/src/mcp.rs` provides an rmcp stdio server, tool router, argument wrappers, JSON replies, error mapping, cancellation handling, and progress forwarding. Reuse its separation of domain logic and transport and its end-to-end MCP test approach. Under the TypeScript choice, this is design/test reuse, not an rmcp dependency. A later Rust host could use rmcp with generated types and parity fixtures; using `schemars` as another hand-authored schema authority would contradict this design.

## 6. Worked demo on owner code

These demos specify six views an agent can produce from real local code. I read the listed files and tests but did not build, execute tests, start a viewer, or observe runtime traces. Read test assertions establish what a test checks, not that it passed in this checkout. Any runtime result must remain "not run" until a scenario actually emits its bundle.

The inspected phoe-nix revision is `d064373a15139b969599ee05bc7b156b1d5b8ed7`; residual-cli is `32c0836283dad8c22431b3025ec910b4b5759e90`. Hashes below identify selected inspected bytes. A generated demo bundle must hash every supporting file it actually uses. Repository work may continue after this note, so these anchors describe this inspection, not a permanent claim about HEAD.

### Vigil, Rust

Root: `/home/mini/Documents/repos/phoe-nix/scout-modules/vigil`, registered as repository `vigil` with revision taken from its enclosing Git repository. The domain entities are watches, ticks, deliveries, and example runs.

| View | Question and inspected answer | Inputs and navigation | Completeness |
|---|---|---|---|
| `vigil-lifecycle`, graph with state labels | "When does a watch stop, and what takes precedence?" `WatchStatus` defines pending/fired/expired/cancelled. `cancel` expires an overdue pending watch before considering cancellation; it preserves an already finished result. Tick logic checks deadline/budget around sensing and judging. | `src/watch.rs:413`, `src/engine.rs:280`, `src/tick.rs:132` and `:178`. Nodes open watch kinds; transition edges open guard excerpts. Later display the same facts in the state-machine preset. | Partial: this demo covers cancellation/deadline branches, not every firing rule, attention event, or recovery path. Read provenance. |
| `vigil-delivery-path`, graph | "Where can an MCP keepalive result stop being delivered?" `run_keepalive` runs work while forwarding progress, checks cancellation during a bounded flush, and calls `commit_delivery` after cancellation checks. | `src/mcp.rs:127` through `:185`, plus the engine delivery implementation when the agent expands scope. A cancellation edge opens source; a delivery node links to the result example. | Partial: transport and delivery bookkeeping need their own evidence; the graph records source control flow, not a complete Rust async execution trace. Read provenance. |
| `vigil-one-write`, example | "Does one write after watch creation reach the first keepalive result?" An existing MCP test writes one error line and asserts fired status, tick 1, next action, and event ID `build:1:0`. | `tests/mcp_e2e.rs:112`. The scenario adapter creates the fixture, performs the exchange, asserts the expected fields, and returns the received envelope as a `vigil/watch-result` entity. Open its data-shape view after a real run. | Not run in this task. The recipe is supported by read test code; an observed result and runtime completeness are absent. |

The example's runner should execute a standalone adapter mirroring that scenario, not scrape `cargo test` stdout and call it an object. The adapter can use the existing subprocess MCP test helpers or a small client. It must preserve a real returned envelope and assertion outcomes. A passed existing test without an exported fixture remains useful supporting evidence but does not satisfy the example-result contract.

Selected input hashes:

| File | SHA-256 |
|---|---|
| `src/watch.rs` | `62f0229b71d3984a5187787780f9a2b26bfc592277281c8ed02b66802e451742` |
| `src/engine.rs` | `79cf0ad0ec83d68638a8ce414bde91375b3e11b93d40e79b00dc1086079e65ca` |
| `src/tick.rs` | `4355040b691eabbf6cbb367f69c1e583701dc5b8b41a421ffba7782fd48f6857` |
| `src/mcp.rs` | `1f627598551a007472cacecb61f4a649b8f60bb089ed16f67ce6f1145d415c25` |
| `tests/mcp_e2e.rs` | `1d0cd2cd40f8e156b3f0b9333c6d6c403b52400be5b17fd288a5d276b0c67e1f` |

### residual-cli's TypeScript browser package

The second codebase is `/home/mini/Documents/repos/residual-cli/web`, registered as repository `residual-web` with root `/home/mini/Documents/repos/residual-cli`. It is the actual TypeScript browser package within a mixed Rust/TypeScript repo. Its `package.json`, `tsconfig.json`, source modules, and tests are present locally. The demo studies the browser implementation, not residual's domain model as a mandatory input format for the new tool.

| View | Question and inspected answer | Inputs and navigation | Completeness |
|---|---|---|---|
| `residual-view-entrypoints`, columned list | "Which views exist, and which code owns them?" The view union is bundle/heatmap/regions; `mountLandscape` imports their builders and owns the active handle. Unknown view values default to bundle. | `web/src/nkp-landscape.ts:14` to `:44` and `:167`. Rows open the builder module entity, a dependency graph, or a source excerpt. Columns include view, factory, controls, and owner. | Complete for the three declared choices in this file; partial for dynamic behavior and other UI panels. The actual envelope must choose the narrower complete criterion or name the broader gaps. Read provenance. |
| `residual-selection-shape`, data shape | "What identity survives switching the drawing?" `EntityKey` distinguishes component, force, and attractor keys. `mountLandscape` owns the selection set; detail and toggle functions live in the pure selection module. | `web/src/landscape-selection.ts:15`, `:45`, `:346`, and `web/src/nkp-landscape.ts:167`. Open key variants, source, and the example scenario. Distinguish TypeScript declarations from observed instance values. | Complete for the declared key union; partial for state changes involving every renderer and filter. Read provenance until a compiler or parser is actually invoked. |
| `residual-selection-switch`, example | "Does a selection survive a view switch and a filter change?" Existing tests explicitly exercise these behaviors. | `web/src/nkp-landscape.test.ts:336` and `:351`; earlier tests at `:270` cover clicking a leaf and sidebar detail. A new scenario adapter emits selected keys and the resulting sidebar detail after each step. | Not run here. Passing assertions and an inspectable `residual/selection-result` must be captured by the adapter. Ordinary UI state can be exported as bounded JSON without retaining a live DOM. |

This is a useful cross-language check: a Rust MCP exchange and a TypeScript DOM interaction return the same example-result envelope while keeping their own scenario runners. Neither extractor nor scenario machinery belongs in the browser renderer.

| File | SHA-256 |
|---|---|
| `web/src/nkp-landscape.ts` | `6eeb5997136297df81c28a9dfec1a4005a8d5560d61e5d0b914015d44523a9df` |
| `web/src/landscape-selection.ts` | `38418e62f565f9f32020068263e5344cb9759a39c17523d6832198f5933e0795` |
| `web/src/nkp-landscape.test.ts` | `d1f9db2be5dffa209793da697ea7c971f4ed07d90a1ab9a15c3ce57f0d5ecd8b` |

### One composed notebook page

Page title: "What survives a change of context?" Scope names both repository snapshots. The opening prose asks whether changing the caller's context loses a result or selection. Its next blocks embed the three vigil views, then the three residual-web views. Evidence links retain each view's repository and revision rather than forcing one synthetic revision over both codebases.

The page records three claims. `D1`, supported by read source, says vigil's MCP wrapper checks cancellation before committing delivery. `D2`, supported by read test assertions, says residual's tests specify persistence of selection across view/filter changes. `D3`, open, asks whether the current checkout satisfies both runnable scenarios. The page links `D3` to the two example blocks and names the missing observed runs. If a future run contradicts a claim, keep the old evidence and mark the claim disputed.

The following ordered page payload makes that composition concrete. Its envelope registers `sv` as the inspected vigil source, `sr` as the inspected residual test source, and `sd` as this design note. The six view IDs resolve to the instances in the demo tables. `D3` has no supporting observation; its evidence identifies the question's origin, not proof of an answer.

```json
{"blocks":[
  {"id":"intro","kind":"prose","markdown":"What survives a change of context?","provenance":"read","evidence":["sd"]},
  {"id":"v1","kind":"view","viewId":"vigil-lifecycle","provenance":"read","evidence":["sv"]},
  {"id":"v2","kind":"view","viewId":"vigil-delivery-path","provenance":"read","evidence":["sv"]},
  {"id":"v3","kind":"view","viewId":"vigil-one-write","provenance":"read","evidence":["sv"]},
  {"id":"D1","kind":"claim","statement":"The MCP wrapper checks cancellation before committing delivery.","status":"supported","supports":["sv"],"contradicts":[],"provenance":"read","evidence":["sv"]},
  {"id":"r1","kind":"view","viewId":"residual-view-entrypoints","provenance":"read","evidence":["sr"]},
  {"id":"r2","kind":"view","viewId":"residual-selection-shape","provenance":"read","evidence":["sr"]},
  {"id":"r3","kind":"view","viewId":"residual-selection-switch","provenance":"read","evidence":["sr"]},
  {"id":"D2","kind":"claim","statement":"The tests specify selection persistence across view and filter changes.","status":"supported","supports":["sr"],"contradicts":[],"provenance":"read","evidence":["sr"]},
  {"id":"D3","kind":"claim","statement":"Does this checkout satisfy both runnable scenarios?","status":"open","supports":[],"contradicts":[],"provenance":"read","evidence":["sd"]}
]}
```

The navigation story is page -> vigil delivery -> cancellation source -> example result, then page -> residual selection shape -> key variant -> example result. A person can follow it visually; an agent can retrieve the same claim/evidence path through bounded references. No conclusion about general productivity follows from these demos.

## 7. Red-phase claims

Each future test states `WHY` and `CLAIM(MCn)`, then exercises the public boundary that owns the behavior. Use committed, hand-specified fixtures independent of code generators. The table specifies acceptance behavior; no implementation or tests were written in this task. Claims covering deferred components become red tests when that component enters scope, not permanent failing tests in v0 CI.

| Claim | Behavior to prove and a test that must fail before implementation |
|---|---|
| MC1 | Required fields, enums, source anchors, unknown properties, and schema versions are checked. Submit a graph with a string depth and an unknown component; assert exact error code and JSON pointer plus a useful expected-type message. Positive control accepts a literal valid fixture. |
| MC2 | Semantic references are checked after shape validation. Reject duplicate item IDs, dangling edges/source IDs, invalid path sequences, reversed line ranges, out-of-excerpt annotations, tree cycles, and alias cycles. Permit graph cycles and repeated entity occurrences in a tree. |
| MC3 | Text and JSON replies honor their byte budget. Use multibyte text and long labels, assert UTF-8 validity, parseable JSON, serialized byte count, exact returned/omitted counts, and usable cursors. Include no-match, one huge item, minimum-budget, and huge-schema discovery replies. |
| MC4 | Completeness is always visible. Drive complete-empty, partial-empty with a named gap, unsupported, and failed operation through CLI, MCP, and browser. Assert distinct visible messages and agent statuses. Remove the gap from a partial payload and expect rejection. |
| MC5 | Provenance cannot disappear in summaries or graphics. Mix read/compiled/observed/inferred items and assert labels and evidence links. Reject observed facts without a run and inferred facts without a reason/basis. A filtered-empty view still reports its evidence coverage. |
| MC6 | Source anchors open the right stored bytes and line numbers. Click an annotation through the real browser route; assert repository, revision, numbered lines, and highlighted range. Modify the local file and assert stale status plus preserved old excerpt. Test traversal and symlink escape with a positive allowed-path control. |
| MC7 | Pane navigation preserves context. Select A -> B -> C, pin B, select a different child of A, switch a view, then use Back. Compare entity IDs, snapshot IDs, selection, and retained branch against a small independent navigation model. Expanding a tree row must not spawn a pane. |
| MC8 | Cross-view links resolve exactly. Follow a graph edge to source and a notebook claim to an example result. A missing target produces a named unresolved result; an old link must not silently open the newest snapshot. |
| MC9 | Rendering is deterministic for a fixed document and viewport. Compare reviewed DOM/SVG structure goldens for list, tree, graph with a cycle, source, shape, notebook, and example. Pin locale, time display, layout version, and viewport. Sort unordered inputs and use fixed graph layout; no time-dependent animation or force simulation. |
| MC10 | Accessibility supports the core route. Using only the keyboard, open a row, change tabs, expand a tree, follow source, dismiss a menu, and return to the invoking control. Assert names, tab relationships, focus order, selection state, and non-color text alternatives. Run an automated accessibility check alongside these behavioral assertions. |
| MC11 | CLI and MCP agree on contracts and failures. Feed both the same literal valid and invalid request bytes. Assert the same IDs, error codes, pointers, summaries, and budgets. Independently verify the MCP `tools/list` schemas match the canonical contract, rather than testing only two generated copies against one another. |
| MC12 | Registering a view changes applicability cheaply. Register a second list view for `vigil/watch` and show it without a browser rebuild. Assert exact-kind matching, raw fallback, lower-priority-first order, stable tie-breaks, missing-data explanation, and explicit preferred-view precedence. |
| MC13 | Freshness accounts for dirty and non-Git sources. Change supporting file bytes while leaving HEAD fixed, make a root inaccessible, and use a directory without Git. Assert stale/unknown/fresh results against independently computed literal fixture hashes. Completeness of the historical snapshot must remain intact. |
| MC14 | Limits are explicit. Submit boundary-sized and oversized views, graphs, nesting, strings, and notebook embeds. Reject over-limit payloads before storage/rendering with a useful scope hint; do not silently render the first N facts. Bound recursive notebook/reference expansion. |
| MC15 | Untrusted content remains data. Submit script tags, closing script tokens in JSON, Markdown event handlers, unsafe URLs, and command-like labels. Assert escaped visible content, no script execution, rejected unsafe actions, and no source reads outside registered roots. Foreign-origin writes fail while the legitimate local client works. |
| MC16 | Notebook revisions preserve evidence and detect conflicts. Import/export a page with ordered claims and references, restart the process, and compare exact content. Two updates from one revision yield one success and one conflict. Inject a failed save and prove the prior revision still opens. |
| MC17 | An example produces a tested inspectable result. Run a tiny independent fixture runner that returns an entity after an assertion. Reject passed-without-result and passed-with-failed-assertion. Test failed assertions, timeout, missing runner, malformed output, and repeated runs with distinct run IDs. A payload cannot install or execute a runner. |
| MC18 | Component-specific unknowns keep their meaning. For later matrix, diff, state, timeline, and heat views, test unknown-vs-zero, partial-before-vs-deleted, nonexistent transition/trace steps, clock units and concurrency, and missing-measurement-vs-low-risk. Assert exact text and labels using a hand-computed fixture for each. |
| MC19 | Filtering and pagination are stable. With equal sort keys and a fixed ID tie-break, concatenate pages and compare against an independently listed expected order. Change the filter or snapshot and expect a cursor-mismatch error. Browser focus and agent counts must describe the same filtered data. |
| MC20 | Storage and browser consume only validated snapshots. Fail a bundle containing one invalid member and assert that no partial registry/notebook update becomes visible. Restart and reopen a valid multi-view bundle. A browser URL must not grant an unregistered entity access to arbitrary local paths. |

Golden fixtures require review of the rendered structure and its meaning; automatic regeneration is not approval. For the build loop, demonstrate that deleting a provenance badge, reversing an edge, bypassing validation, breaking a link, or dropping omitted counts makes the relevant test fail. Do not use source-grep assertions as substitutes for these behaviors.

## 8. Owner questions and proposed defaults

1. Where should reusable domain views live? Default: a per-project JSON registry imported into the session, with an owner-level registry for shared kinds. Keep one-off instances in the notebook until someone chooses to retain their definition.
2. Should selecting a row navigate immediately? Default: Enter or the explicit inspect affordance opens the next pane; pointer row selection can use the same action where there is no competing multi-select interaction. Tree expansion has its own control. Keep selection sets separate from the active inspected item.
3. Is the first week for all thirteen components? Default: the seven v0 components and the two scoped demos above. Deliver specialized state/timeline/matrix/boundary/diff/heat interactions later.
4. May the viewer run scenario commands? Default: only the CLI runs owner-registered local runners; the browser/MCP describes reruns and imports results. External agent execution remains available. No arbitrary payload command execution.
5. How much source should the session retain? Default: submitted excerpts plus evidence hashes, with additional source reads only from registered roots. No full automatic repository copy. Redact secrets before submission and mark the omission as a named source gap.
6. How should stale views refresh? Default: preserve their immutable historical snapshots, show changed paths, and ask the agent to produce a successor. No background re-extraction until an explicit extractor contract exists.
7. Do custom kinds require a universal software model? Default: use a small shared `code/*` vocabulary and project-specific domain kinds. Add shared relations only after both demos need them. Views can accept facts from reading, syntax parsing, compilers, tests, logs, and inference.
8. How much agent output is useful? Default: 8192 serialized bytes with explicit paging, and a 2048-byte lower supported request. Measure answer completeness and navigation steps before expanding limits.
9. Should bespoke renderers be loaded from a view payload? Default: no. Cheap molding means data and registered presets in v0. Add reviewed frontend plugins later when a concrete domain question exceeds the existing grammar.
10. Which checks gate the first build? Default: MC1-MC17 and MC19-MC20 for shipped capabilities, reviewed structure goldens, keyboard route checks, and both example adapters producing inspectable results. MC18 gates the deferred specialized components. A source-inspected demo is labeled as such until its runner has actually executed.
11. Is `paneweft` acceptable as the repo and command name? Default: use that path and name, then repeat the namespace check when creating/publishing the standalone package. No package publication or repository creation is authorized by this note.

## Sources and dates

All web sources below were accessed 2026-11-11. "Undated" means the inspected page exposed no reliable publication date. Source commit dates and paper submission dates identify versions; they are not dates of experimental validation. Local source findings are pinned in section 6.

- [GT inspector views][inspector-views], undated. Basic view kinds and class/superclass definitions.
- [Phlow][phlow], undated. Views, actions, and cross-language implementations.
- [Phlow builder factories][factories], source revision `3cfe58e18b7ead37a718cc52720bafdc1b6ac715`, committed 2026-10-23. Additional kinds and decorators.
- [Phlow view collector][collector] and [base view][base-view], same revision/date. Discovery, targeted actions, title/priority, and view-local actions.
- [CSV domain wrappers][csv-model], undated. Forwarding, columned trees, context item actions, and send behavior.
- [Details migration][details], undated. Dedicated details builder.
- [Mondrian][mondrian], [Mondrian and Bloc][mondrian-bloc], and [graph tutorial][mondrian-examples], undated. Graph construction, nesting, layout, and interactions.
- [GT tour][tour] and [Contextual Playground][playground], undated. Navigation, searches, editing context, and result inspection.
- [REST API case study][rest], undated. Contextual actions and `<gtSearch>`.
- [Lepiter overview][lepiter] and [snippet kinds][snippets], undated. Page/snippet composition.
- [Phlow for Python][python-phlow], undated. A documented implementation outside Pharo.
- [Moldable Tool][moldable-tool], undated. Inspector, Coder, and debugger extension contexts.
- [Nierstrasz and Gîrba, Moldable Development Patterns][patterns-paper], arXiv v1 2024-09-27; EuroPLoP 2024. Read beside the [book's evolving pattern vocabulary][patterns-book], undated.
- [Nierstrasz, Chiş, and Gîrba, Example-driven development][examples-paper], arXiv v1 2024-08-31; LIVE 2024.
- [Chiş, Gîrba, and Nierstrasz, Moldable Exceptions][exceptions], arXiv submission 2024-08-31; Onward! 2024.
- [Chiş et al., The Moldable Inspector][inspector-paper], Onward! 2015-10-25 to 2015-10-30.
- [Chiş et al., Exemplifying Moldable Development][exemplifying], PX/16, 2016-07-18. Contextual extensions as part of application development.
- [feenk research index][feenk], undated. Primary publication catalogue.
- [Ajv JSON Schema support][ajv] and [official MCP stdio guide][mcp-sdk], undated. Implementation candidates, not GT evidence.
- [Existing owner research note 03](03-moldable-development.md), researched 2026-11-10. Used to locate the foundational papers; local repository availability was rechecked for this design.

[inspector-views]: https://book.gtoolkit.com/inspector-views-59974yxnj0txylwrjryp4uc1b
[phlow]: https://book.gtoolkit.com/phlow-6k9vwu9z1evtgk84ta3ptz3gg
[factories]: https://github.com/feenkcom/gtoolkit-phlow/blob/3cfe58e18b7ead37a718cc52720bafdc1b6ac715/src/GToolkit-Phlow/GtPhlowProtoView.class.st
[collector]: https://github.com/feenkcom/gtoolkit-phlow/blob/3cfe58e18b7ead37a718cc52720bafdc1b6ac715/src/GToolkit-Phlow/GtPhlowViewsCollector.class.st
[base-view]: https://github.com/feenkcom/gtoolkit-phlow/blob/3cfe58e18b7ead37a718cc52720bafdc1b6ac715/src/GToolkit-Phlow/GtPhlowView.class.st
[csv-model]: https://book.gtoolkit.com/molding-csv-data---modeling-domain-objects-8jbocadahlawpnci68pl9azox
[details]: https://book.gtoolkit.com/migrating-details-and-info-like-columned-l-4u0wkqwkrgeyzb7xin2y1mjbh
[mondrian]: https://book.gtoolkit.com/mondrian-3uat0i182g4fr7gn2s7683foq
[mondrian-bloc]: https://book.gtoolkit.com/how-mondrian-relates-to-bloc-bcjkcdzqa1sfxsvqlndjhkqgo
[mondrian-examples]: https://book.gtoolkit.com/drawing-graphs-with-mondrian-by-example-b85ad06jfk8gmhvjj8q7poyfc
[tour]: https://book.gtoolkit.com/a-quick-tour-of-gt-83vxlb9x0itmnaket2acyq0n0
[playground]: https://book.gtoolkit.com/contextual-playground-9jkob08mw269cpxowmbe0ld8i
[rest]: https://book.gtoolkit.com/working-with-a-rest-api--the-github-case-s-akzy87sfo25ew7howpf8depta
[lepiter]: https://book.gtoolkit.com/lepiter--a-single-starting-point-for-scrip-2sslgxkw1agkq7liw4heoqycp
[snippets]: https://book.gtoolkit.com/lepiter-snippets-emk0e457pwudb404o7b5q5h76
[python-phlow]: https://book.gtoolkit.com/phlow-for-python-dyl98a2rcczf8f4tdf7e1pstj
[moldable-tool]: https://book.gtoolkit.com/moldable-tool-98p0537dgjllrko3jqmdk8243
[patterns-paper]: https://arxiv.org/html/2409.18811v1
[patterns-book]: https://book.gtoolkit.com/moldable-development-patterns-vuflnrgp5r5o4m1szatoo4e2
[examples-paper]: https://arxiv.org/html/2409.00514v1
[exceptions]: https://arxiv.org/abs/2409.00465
[inspector-paper]: https://scg.unibe.ch/archive/papers/Chis15a-MoldableInspector.pdf
[exemplifying]: https://scg.unibe.ch/archive/papers/Chis16b-ExemplifyingMoldableDevelopment.pdf
[feenk]: https://feenk.com/labs
[ajv]: https://ajv.js.org/json-schema.html
[mcp-sdk]: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md
