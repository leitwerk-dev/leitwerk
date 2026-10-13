# Workflow graph preview

Standalone preview of the application's shared workflow graph.
All examples are synthetic. No application API or proprietary process is used.

From an installed repository checkout:

```sh
npm run dev:workflow-graph
```

Open <http://localhost:4320>. The prototype uses the repository's installed
Svelte and Vite tooling and does not need a Leitwerk server or credentials.

[Repeat path](http://localhost:4320/?variant=loop) opens the graph.
The **Start preview** control opens the
[guided preview](http://localhost:4320/?variant=guided) with a local form.
Earlier graph-variation URLs also open Repeat path. The view and sample are
recorded in the URL; submitting the form never starts a process.

The guided preview follows the graph's shortest successful path:

- Release: Gather → repeated assessment → Publish → Completed.
- Editorial: Draft → Review → Publish → Completed.
- Intake: Assess → Quick response → Completed.
- Repository change: Plan → Implement → Write Commit Message → Publish → Completed.

The **Repository change** sample includes approval and simplification conditions,
separate review and revision ports, and a neutral simplification route rejoining
publication from below. All samples place selected-step details below the graph.
Tool sets are illustrative static declarations, not recorded calls. The guided
preview stacks its path and starting-context form on narrow screens.

See the [Workflow interaction contract](../../docs/ui.md#process-inspector) for
layout, repeat notation, tool disclosure, hover, selection, and keyboard behavior.
The [mapped-turn contract](../../docs/process-sdk.md#mapped-llm-turns) defines item
execution and collection; collection does not add another executed turn.

## Validate

```sh
npm run check --prefix tools/workflow-graph-prototype
```

This runs Biome and the standalone production build. Preview UI changes also need
focused browser/visual checks, including all four samples and the guided form.
Shared-package and application changes require `npm run test:full` in addition
to the preview check; see [Testing](../../docs/testing.md).

## Integration boundary

[`@leitwerk-dev/workflow-graph`](../../packages/workflow-graph/README.md) owns layout,
rendering, and graph inspection. Vite resolves its live source, so renderer edits
appear here without a separate build. The shell adapts synthetic samples to
`ProcessFlowView`; the guided form remains local. There is no second renderer or
routing algorithm.

## Workflow references

- [Camunda multi-instance activities](https://docs.camunda.io/docs/next/components/modeler/bpmn/multi-instance/)
  inform the single activity representing variable repeated work. Explicit wording
  replaces the sequential three-bar marker, which reads as a menu to this audience.
  This prototype does not claim BPMN conformance.
- [AWS Step Functions Map](https://docs.aws.amazon.com/step-functions/latest/dg/state-map.html)
  informs the enclosure around one repeated activity. Leitwerk's mapped items
  execute sequentially; AWS execution modes are not part of this proposal.
- [n8n Loop Over Items](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches/)
  informs the distinction between next-item work and the after-collection exit.
