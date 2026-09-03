# UI Architecture & Layout

The Leitwerk user interface provides real-time visibility and steering control over running AI workflows. This guide explains the three core UI concepts: the Chronicle timeline and Turn Rail layout, live streaming text overlays, and custom extension UI slots.

---

## 1. Chronicle & Turn Rail Layout

The process detail view is organized into three distinct visual regions:

- **Sidebar:** Left navigation pane listing active and scheduled processes for quick switching. Its footer shows the authenticated user's name and a menu for keyboard help and Leitwerk-session logout. When authentication is disabled, the footer shows keyboard help only. Narrow viewports expose the same navigation in a closed-by-default drawer from a sticky shell bar.
- **Turn Rail:** Right-hand outline listing completed turns, active execution leaves, and declared future turns for jumping directly to specific steps.
- **Chronicle:** Main timeline feed rendering live agent reasoning, tool execution logs (bash commands, file diffs), published products, and interactive action controls.

### Route scroll ownership

`RouteViewport` owns scrolling for every standard route. It provides a contained route scroller in the fixed desktop shell and yields to document scrolling below the mobile shell breakpoint. Route pages must not add competing viewport-level `overflow` or `overscroll-behavior` rules. Nested task surfaces such as the Chronicle, modal lists, and desktop split panes may own bounded scrolling.

Process detail is a workspace route. Its `RouteViewport` remains contained so the Chronicle can own timeline scrolling.

---

## 2. Ticket creation modal

Operators can derive a ticket from a durable turn result or leaf outcome. The
initial dialog asks what issue to create and selects a capability-marked ticket
adapter only when more than one is available. It does not preview the result or
ask for a destination. The server snapshots the parent context and sanitized
destination summaries before admitting the derived process through an idempotent durable launch run.

The derived process refines the ticket in the normal process UI. It chooses a
destination from the operator's instructions or asks when the target is ambiguous.
The server resolves that opaque choice into a fresh destination snapshot. The
external-write approval names the destination separately from the proposed tool
arguments so the operator can verify both before accepting the write.

## 3. Live Streaming Text Overlays

When an AI agent is actively executing a turn, text tokens stream over the WebSocket directly into active Chronicle turn blocks:

- **Ephemeral Text Streaming:** Streaming text deltas append directly to local Svelte reactive stores for zero-latency UI updates without refetching full process snapshots.
- **Durable Synchronization:** When a turn completes, a durable server snapshot arrives, seamlessly replacing ephemeral text deltas with the final turn record.
- **Scroll Anchoring:** The timeline automatically scrolls to follow live agent output while allowing operators to scroll up to inspect past history without being forced back to the bottom.

---

## 4. Extension UI Renderers

Process extensions can ship browser UI as custom elements that render leaf outcomes (and related Chronicle slots) for domain-specific props.

### 1. Point `package.json` at a UI manifest

Declare a `leitwerk.ui` block next to the extension entry. Source lane and built lane each get a path:

```json
{
  "name": "@leitwerk-dev/local-repo-change",
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts",
      "import": "./dist/index.js"
    },
    "ui": {
      "source": "./src/ui/manifest.json",
      "import": "./dist/ui/manifest.json"
    }
  }
}
```

### 2. Map renderer ids to custom elements

The manifest lists renderers by stable id. Each entry is a `custom_element` with a tag name and module path:

```json
{
  "apiVersion": 1,
  "extensionManifestId": "local-repo-change",
  "renderers": {
    "@leitwerk-dev/local-repo-change:local_repo_change_process.leaf_outcome": {
      "kind": "custom_element",
      "tagName": "o2-local-repo-change-legacy-leaf-outcome",
      "module": "./leaf-outcome-element.ts",
      "rendererApiVersion": 1
    }
  }
}
```

Durable leaf-outcome captures reference the same `rendererId`. The UI loads the module from the extension UI catalog and defines the custom element when the Chronicle needs that slot. See `extensions/local-repo-change` for a shipped example (legacy leaf-outcome compatibility renderer).

- **Bounded Insertion:** Custom renderers stay inside Chronicle leaf-outcome hosts; they do not own global shell navigation.

---

## 5. Turn progress

Automatic turns and LLM preparation phases may expose a durable ordered progress report in their Chronicle cluster. The
UI names every step state, highlights the current step, preserves failed steps beside generic
recovery controls, and lists created pull requests, merge requests, commits, or pipelines under
**Created changes**. Historical reports remain part of their owning turn attempt. Status text
and symbols carry the meaning without relying on color.

## 6. Launch checklist

An immediate launcher submission uses `POST /api/launchers/:launcherId/launch-runs`, replaces its
submit area with the durable launch checklist, and keeps the entered draft in memory. Scheduled
submissions use `POST /api/launchers/:launcherId/future-launches`; saving a future launch does not
create a launch run or startup checklist. The browser navigates when the run gains an `instanceId`; the
process detail then renders authoritative startup history inside the Chronicle. Text and symbols
name every state. The current step uses the operational accent. Failed steps show bounded
remediation and the existing recovery action. Process detail never selects a Launch Run to infer
startup: it uses the correlated worker start, lease, readiness observation, and accepted first turn.
A failed attempt remains visible after recovery. Terminal launcher runs collapse to an expandable
summary; failed runs expand again when the operator selects the summary.
