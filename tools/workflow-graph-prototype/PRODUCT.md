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

Follow the shared [Workflow interaction contract](../../docs/ui.md#process-inspector)
for layout, turn kinds, tools, inspection, and keyboard behavior. Execution and
empty-collection semantics belong to the [mapped-turn contract](../../docs/process-sdk.md#mapped-llm-turns).
[DESIGN.md](DESIGN.md) records the preview's visual treatment.

- Use the repeat-path treatment exclusively, without a comparison switcher.
  Named-item chains suggested a fixed number of turns and were rejected; keep
  collection size unknown, with no example-run controls or item lists.
- Pair “For each” with a repeat-arrow icon. Three-bar and stacked markers read
  as menus, while text alone looks like an ordinary turn.
- Release readiness must read Gather → repeat → Publish → Completed on one line.
- The guided preview follows the same successful path; conditional work remains
  discoverable rather than becoming mandatory steps.
- Use synthetic content. Do not copy the proprietary linked process or inspect
  its implementation in the neighboring repository.
- Keep experimental actions local. No live process is created by the preview.

## Evidence on Hand

The supplied screenshot demonstrates overflowing single-line titles and mapped
turns that appear as ordinary nodes.

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
