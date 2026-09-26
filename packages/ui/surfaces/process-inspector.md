# Process inspector surface

Mode: Operate. Implemented in [ProcessInspector.svelte](../src/pages/process-detail/inspector/ProcessInspector.svelte) and its sibling components, selected through `inspect` links on `/processes/:instanceId`. This surface extends the existing [design system](../DESIGN.md) and complements the [process chronicle](process-chronicle.md).

## Purpose and direction

Operators investigate what an execution received, did, and produced, then follow its context back to the source. Process reference material and recorded execution evidence share one reading surface. The defining interaction is opening an exact source boundary, seeing where inherited context ends, and returning through the investigation without losing the chronicle draft or reading position.

## Composition

The inspector replaces the process content region beside global navigation. A persistent header contains Back and Show in chronicle, process and step breadcrumbs, the selected identity, and section links. Executions add attempt number, recorded facts, Previous and Next controls, and a muted context-origin summary with source and context-map links. The evidence pane scrolls below this header, with content centered at a maximum width of 960px.

Use the incumbent Public Sans heading, body, and caption scales. White working surfaces, muted gray context blocks, thin dividers, and compact rounded disclosures establish hierarchy. Operational blue marks links, selected sections, focus, and the inherited-context boundary. Body copy remains dark and readable; IDs and raw values use the existing monospace face. The surface uses no added shadow, raster asset, or decorative treatment.

## Scope and reading order

Process sections are Overview, Workflow, Inputs & configuration, and Context map:

- Overview groups compact label/value facts, usage coverage, recorded repositories, and deliverable links. The source identifier and project labels carry their external links directly. Repository configuration does not imply that a repository changed; partial usage remains explicit.
- Workflow presents the current graph and a text list of steps. Step references expose purpose, contracts, model policy, tool declarations, instructions, and possible transitions. Current definitions are labeled explicitly, including the absence of a launch-time graph snapshot.
- Inputs & configuration leads with the full original request, followed by recorded launch parameters, model defaults and overrides, scoped settings, and infrastructure details. Separate the default at creation from mutable current settings. Scoped settings distinguish future defaults from captured prepared-step values and link to the relevant [Settings scope](settings.md).
- Context map offers Map and List as alternate views within the available evidence pane. The compact diagram opens at the selected execution, with zoom, Fit map, and Show selected controls; the list also reveals that selection on arrival. Broader map explanations use a disclosure. Conversation inheritance and supplied products remain distinct. An unconnected execution can have unknown context.

Execution sections are Trace, Context, and Configuration:

- Trace presents messages, recorded reasoning, tools, events, questions, and execution output. A source-boundary marker states that later activity was not inherited. Unassigned session history stays in a disclosure that names its unknown execution ownership.
- Context leads with inherited conversation and exact source links, then compaction summaries, supplied product versions, and model inputs. Supplied products distinguish a recorded read from supply without a recorded read.
- Configuration presents recorded model selection and per-call prompts, appended instructions, context files, and available tools. A separate Current reference section links to present workflow settings and states that they may have changed.

## Evidence and navigation

Native disclosures pair each evidence label with its state: recorded, redacted, not recorded, unavailable, or not applicable. Missing evidence includes a reason. Recorded empty values remain distinguishable from missing values. Original requests and retained prompts stay available in full; Copy copies the complete retained value. Redacted evidence identifies that sensitive values have been removed. Long raw values wrap within bounded scroll areas.

Explicit links choose the process, step, execution, or trace item. Back and browser history retrace investigations and restore evidence position and disclosures. New inspector locations focus the identity heading. Show in chronicle restores the original reading position and focus, or reveals the selected execution when the investigation has moved to another record. Step references can reveal matching executions.

The chronicle stays mounted, hidden, and inert while inspection is open. Its automatic scrolling pauses, and action and recovery drafts survive the round trip. Live Trace starts without following; Follow live opts into scrolling, and scrolling away ends following. New activity is announced without changing the selected execution. Open questions provide Answer in chronicle. Loading, empty, invalid-target, unavailable-source, and request-error states use readable inline messages; failed evidence requests expose Retry.

## Responsive behavior

The mobile inspector remains contained below the global shell bar. Its identity, context summary, and section links wrap above the evidence pane, which retains its own scrolling. At 720px and below, header and evidence padding tighten, facts and step lists become one column, and definition labels stack above their values. Overview fact labels remain beside their values; repository branch facts sit beneath their repository. Section links and map controls keep a 44px minimum height. The context diagram and its alternative list each scroll within the remaining space, keeping view and navigation controls reachable.

No unresolved surface decision remains.
