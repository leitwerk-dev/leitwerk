# Workflow graph preview

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Process authors need to check the complete set of transitions at a glance.
Process users need to understand what a process does, including before starting it.
The confirmed direction is a shared clear overview with optional author details.

## Product Purpose

Explore a Leitwerk process workflow using the selected repeat-path design.
Make repeated work visible, keep labels readable, and explain steps through
hover, selection, and inline details.

## Operating Context

This preview uses the same workflow graph package as the application. Multiple
synthetic examples remain available without a server, account, or live process.
Renderer changes must appear in both surfaces; the guided form remains local.

## Capabilities and Constraints

- A mapped LLM turn is one logical turn applied sequentially to a frozen ordered
  list. Item outcomes yield results; collection routes once after all items.
- An empty list collects zero results and routes without an item execution.
- A map's next-item repetition differs from a declared workflow loop or retry.
- The definition graph must show one repeated activity, not a chain of named
  items. The user found that chain misleading because it suggested a fixed
  number of turns.
- Keep the repeated activity concise. The definition works for an unknown
  collection size and has no example-run controls or named-item lists.
- Use the repeat-path treatment exclusively: one activity, a local next-item
  return, and an exit to collection. Remove the comparison switcher and the
  alternative label and scope treatments.
- Pair the outer “For each” label with a repeat-arrow icon. Text alone looks too
  much like an ordinary turn; three-bar and stacked markers read as a menu.
- Match Chronicle turn-kind symbols: sparkles for LLM work, a cog for automation,
  and a person with a check for operator decisions. Keep turn kind distinct from
  the outer repetition symbol.
- Show the tools available to each ordinary or mapped LLM turn. Keep a compact
  count beside the activity. Tool rows start collapsed, showing only their names;
  expand a row to show its category and purpose. Include
  workspace, integration, question, and outcome tools where declared. A mapped
  outcome yields one item result; collection still chooses the outgoing route.
- Show a generic collection junction inside the repeated turn. It combines the
  ordered results, updates state, and routes once; it is not another executed turn
  or a built-in result presentation step.
- The shortest path to successful completion leads the diagram on one horizontal
  line. Count a mapped turn once and keep collection inside it. Aborted is not a
  successful destination. Release readiness must read Gather → repeat → Publish →
  Completed on that line.
- Put conditional work, rework, and cancellation beside the main path. Align
  ports for straight horizontal or vertical connections where possible; use a
  diagonal when it makes a connection clearer. Avoid incidental crossings and
  shared arrival segments that make distinct routes look like one arrow.
- Internal and external connectors share one coordinate origin. Selection and
  border styling must not shift their endpoints at the repeat enclosure.
- The repeat enclosure, inner LLM activity, and collection junction are separate
  hover and keyboard targets. Feedback follows the current target even while
  details for another target are open. Collection emphasis stays on its diamond
  and label; highlights and tooltips must leave internal connectors visible.
- Arrows support direct hover and keyboard focus. Each highlights only its own
  complete route, including internal continuations, without replacing step
  selection. Neighboring steps must not highlight unrelated repeat exits.
  Next-item paths are neutral by default; blue means a route is highlighted.
- The guided preview follows the same successful path. Alternative work remains
  discoverable as conditional detail, not a mandatory step in that sequence.
- An operator decision is a distinct turn with explicit actions.
- Completed and aborted are terminal states. An error is not a terminal state.
- Use synthetic content. Do not copy the proprietary linked process or inspect
  its implementation in the neighboring repository.
- Keep experimental actions local. No live process is created by the preview.

## Evidence on Hand

The supplied screenshot demonstrates overflowing single-line titles and mapped
turns that appear as ordinary nodes. Existing implementation and contracts:

- `packages/ui/src/pages/ProcessFlowDiagram.svelte`
- `packages/workflow-graph/src/WorkflowGraph.svelte`
- `packages/workflow-graph/src/layout.ts`
- `packages/ui/src/chronicle/components/ChronicleEntryHeader.svelte`
- `packages/ui/src/chronicle/components/ChronicleTurnRail.svelte`
- `docs/process-sdk.md`, Mapped LLM turns
- `packages/server/src/process-engine/mapped-turns.ts`

Paths are relative to the repository root.

## Product Principles

- Show control flow and repeated item work without conflating them.
- Keep every declared route discoverable.
- Let people inspect detail without losing their place in the graph.
- Derive placement from path and connection roles instead of per-example drawing
  coordinates, so layout rules can be assessed alongside the visual treatment.
- Use the same repeat-path notation across the synthetic examples.

## Open Decisions

The repeat-path notation and shared production package are selected. Runtime
execution overlays are outside this definition preview.
