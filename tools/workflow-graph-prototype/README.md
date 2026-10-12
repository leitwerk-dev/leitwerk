# Workflow graph preview

Standalone preview of the application's shared workflow graph.
All examples are synthetic. No application API or proprietary process is used.

From an installed repository checkout:

```sh
npm run dev:workflow-graph
```

Open <http://localhost:4320>. The prototype uses the repository's installed
Svelte and Vite tooling and does not need a Leitwerk server or credentials.

[Repeat path](http://localhost:4320/?variant=loop) is the graph view: one activity
with a local next-item path, followed by an internal collection junction.
The **Start preview** control opens
the [guided preview](http://localhost:4320/?variant=guided) with a local form.
Earlier graph-variation URLs also open Repeat path.

The shortest route to **Completed** is the main horizontal line. Collection is
inside its mapped turn when choosing that route; an aborted outcome is not
success. The examples therefore lead with:

- Release: Gather → repeated assessment → Publish → Completed.
- Editorial: Draft → Review → Publish → Completed.
- Intake: Assess → Quick response → Completed.
- Repository change: Plan → Implement → Write Commit Message → Publish → Completed.

The **Repository change** sample includes separate review and revision ports,
named approval and simplification conditions, and a neutral simplification route
that rejoins the main path from below. Its connector runs midway between rows,
clear of the upper boxes. Hover the conditional arrows to inspect their policy
and common outcome. All showcase samples put selected-step details below the
graph, preserving its width while inspecting tools and routes.

Conditional work and cancellation occupy side lanes. Rework uses an outside
return path. Aligned ports keep simple connections straight, and alternate
arrivals keep their own arrowheads instead of merging into a shared final line.
Repeat-box borders and selection do not move internal connector endpoints.
The guided preview follows the same main path and exposes alternatives as
conditional actions.

The view and workflow sample are recorded in the URL. Hover or focus a step for a
quick explanation; select it to inspect its input, output, and outgoing routes.
The repeat enclosure, LLM activity, and collection each respond to hover and
keyboard focus. The enclosure highlights the whole repeat, the activity its
item work and next-item loop, and collection its result gathering and outgoing
routes. This feedback follows the current target while an inspector is open.
Collection highlights its diamond and label, leaving connectors visible.
Repeat tooltips sit outside the enclosure.
Hover or focus an arrow to highlight that route, including its continuation inside
the repeat. Clicking or tapping an arrow focuses it and preserves the selected
step and inspector. Next-item paths are neutral by default; all routes use blue
when highlighted. A neighboring step highlights only its connected routes.
Mapped items execute sequentially within one logical turn. The next-item loop
is distinct from a workflow transition back to an earlier turn.

Turn kinds use the Chronicle's visual language: sparkles for **LLM turn**, a cog
for **Automation**, and a person with a check for **Operator decision**. The
repeat-arrow icon belongs to the enclosing mapped turn.

LLM activities show their available tool count. Select an activity for the tool
list, visible without **Author details**. Each row starts collapsed and shows
only the tool name. Expand it to read its category and purpose. Tools that finish
an ordinary turn or yield one mapped item result
are included. Tool sets are illustrative, specific to each synthetic turn, and
describe availability rather than recorded calls.

**Collect results** is a generic, selectable internal junction. It combines the
ordered item results, updates state, and chooses the outgoing route. It runs once,
including for an empty collection. It does not add an executed turn or an LLM call;
any user-visible presentation comes from the process's item results and later steps.

The graph shows the workflow definition with one repeated activity. Example-run
controls and item lists have been removed to keep inspection focused on the turn.
**Author details** reveals inputs, outputs, and route conditions. Use **Escape**
to close the inspector. Tool disclosures work with pointer, Enter, and Space.

On narrow screens the graph scrolls horizontally; selected details appear below
it. The guided preview stacks into a readable sequence and starting-context form.

## Validate

```sh
npm run check --prefix tools/workflow-graph-prototype
```

This runs Biome and the standalone production build. Browser checks should cover
all four workflow samples, long labels, tool disclosure and focus, route
selection, and the guided preview. Verify repeat-box connector continuity at
different zoom levels and in selected and unselected states.
Check pointer movement and keyboard focus between the enclosure, activity, and
collection, both with and without an open inspector. Escape returns focus to the
control that opened the details.
Check direct arrow hover and focus, next-item paths at rest, and route continuity
when hovering a step with several incoming routes.
Check that LLM and automation symbols match the Chronicle, and that collection
stays inside the repeated turn with its post-collection routes available on selection.

## Integration boundary

`@leitwerk-dev/workflow-graph` owns layout, rendering, and graph inspection. Both
this preview and the application import its Svelte component. Vite resolves the
live package source, so renderer edits appear here without a separate build.
The shell adapts its synthetic samples to `ProcessFlowView`; it has no second
renderer or routing algorithm. The guided form remains local to this preview.

The SDK projects mapped-turn metadata and static tool declarations without
evaluating runtime callbacks. The graph indicates dynamic tools separately;
execution inspection owns captured tool availability. Shared-package and
application changes require `npm run test:full` in addition to the preview check.

## Workflow references

- [Camunda multi-instance activities](https://docs.camunda.io/docs/next/components/modeler/bpmn/multi-instance/)
  inform the single activity representing variable repeated work. The prototype
  uses explicit wording: the conventional three-bar sequential marker reads as a
  menu to this audience. This prototype does not claim BPMN conformance.
- [AWS Step Functions Map](https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html)
  informs the enclosure around one repeated activity. Leitwerk's mapped items
  execute sequentially; AWS execution modes are not part of this proposal.
- [n8n Loop Over Items](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/)
  informs the visual distinction between next-item work and the after-collection
  exit. Collection remains inside one logical Leitwerk turn.
