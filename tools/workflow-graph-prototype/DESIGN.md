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

## Colors

Use the palette in the frontmatter. Blue marks active transitions, selected nodes,
focus, links, and primary actions; amber marks rework; green marks completion.
Keep these meanings distinct and use cool neutrals for structure and explanation.

Turn-kind chips follow the Chronicle: LLM sparkles use the accent color;
automation cogs and collection junctions use neutral ink. Their shapes and labels
carry the distinction independently of color.

## Typography

Use the frontmatter's type scales. Larger headings rely on size and weight rather
than a contrasting display face. Numeric counters use tabular figures.

- Page headings reduce to 24px on narrow screens.
- Mapped-turn and inspector headings use 600 weight at 16px.
- Workflow node titles use 600 weight at 15px with 1.4 line height; long titles wrap.
- Keep explanatory copy within 65ch.

Keep graph metadata smaller than node titles and explanations; use weight and
spacing to separate levels before adding decorative treatments.

## Layout

Repeat path uses a scrollable graph canvas with computed layout. In the showcase, selected-step details always appear below the graph, matching the application's inspector view and preserving graph width. The guided preview pairs the same successful path with a starting-context form, then stacks those regions on narrow screens. At mobile widths, page gutters contract to 14px and graph exploration stays horizontally scrollable with a visible hint. Repeated spacing values cluster around 8px, 16px, and 24px.

Follow the [Workflow contract](../../docs/ui.md#process-inspector) for path placement, ports, repeats, route conditions, and inspection. Equal-length successful paths use declaration order.

Allocate space from the largest node in each column. Keep connectors clear of nodes, repeat headers, and other routes. Internal paths and external routes share the repeat enclosure's coordinate origin; border and selection styling must not shift them.

## Elevation & Depth

Most surfaces use borders and pale blue-gray fills rather than shadows. The hover tooltip uses a soft shadow above the canvas. Selected state is expressed with a stronger blue border and tinted fill. Node transitions are brief; the inspector reveal is removed when reduced motion is requested.

### Shadow Vocabulary
- **Tooltip** (`0 6px 25px #182b452e`): Keeps a transient explanation readable over the graph.

## Components

### Workflow graph
- **Character:** A direct topology view where every declared route stays discoverable.
- Use the frontmatter's node and panel styles with 1px borders. Hover adds a pale blue fill; selection uses a 2px blue border and light blue fill.
- Route labels sit on an opaque light backing for contrast. Active routes turn blue; idle rework routes are amber. Muted routes remain visible.
- Terminal completion is green-tinted; abort is neutral gray.

Collection and empty-list behavior belong to the [mapped-turn contract](../../docs/process-sdk.md#mapped-llm-turns).

### Repeated activity
- Use the xl radius for the pale blue, dashed enclosure around one activity and its local return path.
- Keep labels to the activity title and a short repeat cue; move explanations to inspection.
- Pair “For each component/topic” with a repeat-arrow icon on the outer boundary. Three-bar and stacked markers read as menu controls.
- One LLM activity and a generic collection junction share the enclosure; no item lists or example-run controls are shown.
- Keep collection's hit area transparent. Tint its diamond and label without
  covering connectors; keyboard focus marks the label below the connection axis.

### Turn kinds and collection
- Reuse Chronicle sparkle, cog, and person-with-check symbols in circular chips.
- The repetition icon belongs to the outer scope; the inner activity retains its LLM icon.
- Place a small tool-count cue on LLM activities.
- **Collect results** uses a neutral merge/junction symbol between item work and business routes.

### Graph and guided preview
- **Repeat path:** One activity with a local next-item path, followed by the collection junction.
- **Guided preview:** Reached through **Start preview**; presents the journey and a local start-context form together. Repeated work uses one short cue.
- Keep both views on the same palette and typography.

The design draws on Camunda/BPMN's single multi-instance activity, AWS Step Functions Map enclosures, and n8n's loop/done distinction. Repeat wording replaces BPMN's three-bar symbol, which this audience reads as a menu. See README.md for source links. The prototype does not claim conformance with those systems or inherit their execution semantics.
