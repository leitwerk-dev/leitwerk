# Workflow graph

`@leitwerk-dev/workflow-graph` owns the workflow definition renderer and its pure
layout. The application UI and synthetic preview use this same package.

```svelte
<script lang="ts">
  import WorkflowGraph from "@leitwerk-dev/workflow-graph/WorkflowGraph.svelte";
  import type { ProcessFlowView } from "@leitwerk-dev/domain";

  let { flow }: { flow: ProcessFlowView } = $props();
</script>

<WorkflowGraph {flow} />
```

`flow` is a static definition projected by the SDK. The component performs no
network requests or process execution. Optional `onInspectTurn(turnId)` adds an
**Open turn details** action; selecting a node opens local graph details first.
Chronicle CSS tokens supply the theme, with standalone fallbacks.
`internal/WorkflowIcon.svelte` is shared implementation, not a supported extension API.

See the [Workflow interaction contract](../../docs/ui.md#process-inspector) for
layout, repeat notation, tools, and inspection behavior. The graph describes the
current definition, not the tools or items of a particular execution.

From the repository root, run `npm run dev:workflow-graph` and open
<http://127.0.0.1:4320>. This preview uses live package source, four synthetic
definitions, and a local guided form. It requires no server or credentials.
See [the preview](../../tools/workflow-graph-prototype/README.md) for controls.

Build with `npm run build -w @leitwerk-dev/workflow-graph`. Changes to this package
require `npm run test:full`; preview-only changes also need the standalone check:
`npm run check --prefix tools/workflow-graph-prototype`.
