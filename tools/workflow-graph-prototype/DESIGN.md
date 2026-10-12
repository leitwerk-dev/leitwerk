---
name: Leitwerk Workflow Lab
description: A clear, interactive workspace for exploring synthetic process flows.
colors:
  blue: "#2f61b7"
  page: "#f7f8fa"
  paper: "#ffffff"
  ink: "#18212b"
  muted: "#5c6a7b"
  line: "#e1e6ed"
  emerald: "#257651"
  amber: "#9a641b"
typography:
  display:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "27px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.8px"
  body:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Public Sans, sans-serif"
    fontSize: "9px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "0.65px"
rounded:
  sm: "5px"
  md: "8px"
  lg: "12px"
  xl: "14px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  flow-node:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px 17px"
  graph-panel:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
---

# Design System: Leitwerk Workflow Lab

## Overview

**Creative North Star: The Working Map.**

The interface treats a process as a readable map of work: steps are compact cards, transitions remain visible, and a repeated activity appears once regardless of its collection size. Blue marks focus and active routes; muted neutrals carry structure and explanation. The overall density is deliberately practical, with labels and route conditions close to the graph they describe.

The preview serves process authors inspecting topology and process users learning what happens before starting. Selection opens deeper inspection while preserving the map; the optional Author details control reveals input and output fields. Repeat path is the selected graph treatment. The application and preview share the renderer and layout in `@leitwerk-dev/workflow-graph`.

**Key Characteristics:**
- Blue-led, low-saturation interface on a cool gray page.
- Small, consistent Public Sans typography with clear weight changes.
- Visible routes, concise repeat cues, and detail on demand.

## Colors

Cool neutrals keep dense diagrams legible; blue signals selection, focus, and active flow, while amber identifies rework loops and green marks completion.

Turn-kind chips follow the Chronicle: LLM sparkles use the accent color;
automation cogs and collection junctions use neutral ink. Their shapes and labels
carry the distinction independently of color.

### Primary
- **Route Blue** (#2f61b7): Active transitions, selected nodes, focus, links, and primary actions.

### Neutral
- **Cool Page** (#f7f8fa): Application canvas.
- **Paper** (#ffffff): Graph, nodes, inspectors, and preview surfaces.
- **Ink** (#18212b): Main text.
- **Slate** (#5c6a7b): Supporting labels and descriptions.
- **Divider** (#e1e6ed): Shared separators and subtle structure.

### Named Rules
**The Route Meaning Rule.** Blue marks selection and active movement; amber marks a rework loop; green marks completion. Keep these meanings distinct.

## Typography

**Display Font:** Public Sans (with sans-serif fallback)
**Body Font:** Public Sans (with sans-serif fallback)
**Label/Mono Font:** Public Sans; numeric counters use tabular figures.

**Character:** A compact, neutral sans-serif keeps diagram labels direct and scannable. Larger headings rely on size and weight rather than a contrasting display face.

### Hierarchy
- **Display** (650, 27px, 1.2): Page heading; reduces to 24px on narrow screens.
- **Headline** (600, 16px, normal): Mapped-turn and inspector headings.
- **Title** (600, 15px, 1.4): Workflow node titles; long titles wrap within their cards.
- **Body** (400, 14px, 1.7): Base interface text; explanatory copy uses a readable measure up to 65ch.
- **Label** (650, 9px, 1.5, 0.65px tracking, uppercase): Node kinds and compact metadata.

### Named Rules
**The Compact Hierarchy Rule.** Keep graph metadata smaller than node titles and explanations; use weight and spacing to separate levels before adding decorative treatments.

## Layout

Repeat path uses a scrollable graph canvas with computed layout. In the showcase, selected-step details always appear below the graph, matching the application's inspector view and preserving graph width. The guided preview pairs the same successful path with a starting-context form, then stacks those regions on narrow screens. At mobile widths, page gutters contract to 14px and graph exploration stays horizontally scrollable with a visible hint. Repeated spacing values cluster around 8px, 16px, and 24px.

The shortest successful route defines a horizontal baseline. Treat the mapped activity and collection as one step when choosing it, exclude aborted outcomes, and break equal-length ties consistently. Place node centers and their main connection ports on that baseline. Release readiness reads Gather → repeated assessment → Publish → Completed.

Conditional work belongs in a separate lane, placed relative to its branch and return point. Release review sits above publication; research is a lower branch in intake. Rework travels around the outside. Allocate space from the largest node in each column so repeated groups and long labels remain readable.

Keep simple connections horizontal or vertical, with diagonals available when clearer. Give alternative arrivals distinct ports and arrowheads. Order connections along each side by their opposite endpoints, so a left-going revision and a right-going cancellation leave a decision without crossing. Keep the main path's ports centered. Avoid incidental crossings, shared final segments, and connections that pass through a node or the repeat header. Collection and the inner LLM activity share the main connection axis; optional repeat ports connect to their respective internal elements.

Internal paths and external routes share the repeat enclosure's coordinate origin. Border and selection styling must not shift the inner activity, junction, or connectors. The graph has no variation switcher or reserved comparison dock.

The Repository change sample keeps review departures separate from revision arrivals at Plan. Side paths rejoin the main line from their own side, using the middle of the gap between rows. Applying simplification enters Commit from below with a neutral route; amber belongs to cycles that return to earlier work. Conditional arrows show distinct branch names, with the common outcome and policy explanation in hover details.

## Elevation & Depth

Most surfaces use borders and pale blue-gray fills rather than shadows. The hover tooltip uses a soft shadow above the canvas. Selected state is expressed with a stronger blue border and tinted fill. Node transitions are brief; the inspector reveal is removed when reduced motion is requested.

### Shadow Vocabulary
- **Tooltip** (`0 6px 25px #182b452e`): Keeps a transient explanation readable over the graph.

## Shapes

Cards and major panels use softly rounded corners: nodes are 12px, repeat enclosures and graph panels 14px, and smaller controls generally 5–8px. Thin cool-gray borders define neutral containers. The repeat enclosure uses a pale blue background and a dashed border around one activity template and its local return path.

## Components

### Workflow graph
- **Character:** A direct topology view where every declared route stays discoverable.
- Nodes use white surfaces, 1px borders, 12px corners, and 20px by 17px padding. Hover adds a pale blue fill; selection uses a 2px blue border and light blue fill.
- Route labels sit on an opaque light backing for contrast. Active routes turn blue; idle rework routes are amber. Muted routes remain visible.
- Terminal completion is green-tinted; abort is neutral gray.

### Repeated activity
- **Character:** One activity is applied to a variable collection, one item at a time. Collection stays inside the turn and selects one outgoing route.
- Keep the graph label to the activity title and a short repeat cue. Move explanations and collection behavior to inspection.
- Pair “For each component/topic” with a repeat-arrow icon on the outer boundary. Avoid three-bar and stacked markers: the user reads them as menu controls.
- One LLM activity template and a generic collection junction share a small “For each” enclosure.
- A neutral local next-item path shows repetition and turns blue when highlighted. Collection follows the “All items done” exit. Idle amber routes represent business rework between turns.
- Keep the graph independent of collection size. Collection details explain that an empty list still collects and routes once; no example-run controls or item lists are shown.
- Give the enclosure, LLM activity, and collection separate pointer and keyboard
  targets. The enclosure emphasizes the whole mapped turn; the activity emphasizes
  incoming work and its next-item loop; collection emphasizes result gathering
  and outgoing routes. Selection persists while hover or focus previews another target.
- Arrows are independent hover and keyboard targets. Highlight only the targeted
  route, including its continuation across the enclosure boundary. Next-item and
  all-items-done paths respond independently. Clicking an arrow focuses it while
  preserving the selected step and inspector. Hovering a neighboring step must
  not highlight unrelated internal exit segments.
- Keep collection's hit area transparent. Tint and strengthen the diamond and
  label without placing a filled rectangle over connectors. Keyboard focus marks
  the label below the connection axis. Place repeat tooltips outside the enclosure
  so they do not cover its internal paths.

### Turn kinds and collection
- LLM turns reuse the Chronicle's filled sparkle icon; automation reuses its cog; operator decisions reuse its person-with-check icon. Use the same circular icon chips and the labels **LLM turn**, **Automation**, and **Operator decision**.
- The repetition icon belongs to the outer scope. The inner activity retains its LLM icon.
- LLM activities carry a small tool-count cue. The inspector's **Available tools**
  section is visible without Author details. Each tool is an independent native
  disclosure, collapsed by default to its name and a chevron. Expansion reveals
  its category and purpose. Tools belong to the inner LLM activity, including in mapped turns.
  Outcome tools are included; label mapped outcomes **Finish item** so they remain
  distinct from collection and routing. Expanding a tool reveals information;
  it never executes the tool. Selecting another turn resets the disclosures.
- **Collect results** uses a neutral merge/junction symbol. Connect item work to this boundary, then take the business routes from it.
- Collection is an inspectable part of the mapped turn, not a separate turn. Its details explain ordered aggregation, state updates, and routing once, including for an empty collection. It does not imply an additional LLM call or an automatic user-visible presentation.

### Inspection and tooltip
- Hover or keyboard focus provides a short explanation and route count. For mapped turns, count the possible routes after collection. Selecting a step highlights connected routes and opens the inline inspector beside the graph on wide screens or below it on narrow screens.
- Keep inputs, outputs, and route conditions available in the inspector. Author details are an optional disclosure.
- Selecting the enclosure and then its activity keeps the same mapped-turn
  details open. Escape closes inspection and returns focus to the exact opener.
- Closing inspection clears the tooltip while restoring keyboard position. The
  latest hover or keyboard interaction owns the preview; leaving a hovered target
  clears it instead of reviving an earlier focus tooltip.

### Graph and guided preview
- **Repeat path:** One activity with a local next-item path, followed by the collection junction.
- **Guided preview:** Reached through **Start preview**; presents the journey and a local start-context form together. Repeated work uses one short cue.
- Keep both views on the same palette and typography.

The design draws on Camunda/BPMN's single multi-instance activity, AWS Step Functions Map enclosures, and n8n's loop/done distinction. Repeat wording replaces BPMN's three-bar symbol, which this audience reads as a menu. See README.md for source links. The prototype does not claim conformance with those systems or inherit their execution semantics.

## Do's and Don'ts

### Do:
- **Do** keep long node titles contained and wrapped inside their cards.
- **Do** retain route labels and make selected topology visually clear.
- **Do** represent mapped work as one repeated activity with one post-collection route choice.
- **Do** make the zero-item collection behavior explicit in collection details.
- **Do** keep the guided preview local and label it as a preview.

### Don't:
- **Don't** imply every mapped item is a separate workflow turn.
- **Don't** place named item chains, fixed counts, or collection paragraphs inside the definition graph.
- **Don't** conflate a map's next-item iteration with a declared rework route.
- **Don't** make hover the only way to reach step details; graph controls must also work with focus and selection.
- **Don't** fork the renderer or layout in the preview; change the shared package.
