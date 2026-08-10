# UI Architecture & Layout

The Leitwerk user interface provides real-time visibility and steering control over running AI workflows. This guide explains the three core UI concepts: the Chronicle timeline and Turn Rail layout, live streaming text overlays, and custom extension UI slots.

---

## 1. Chronicle & Turn Rail Layout

The process detail view is organized into three distinct visual regions:

- **Sidebar:** Left navigation pane listing active and scheduled processes for quick switching.
- **Turn Rail:** Right-hand outline listing completed turns, active execution leaves, and declared future turns for jumping directly to specific steps.
- **Chronicle:** Main timeline feed rendering live agent reasoning, tool execution logs (bash commands, file diffs), published products, and interactive action controls.

---

## 2. Live Streaming Text Overlays

When an AI agent is actively executing a turn, text tokens stream over the WebSocket directly into active Chronicle turn blocks:

- **Ephemeral Text Streaming:** Streaming text deltas append directly to local Svelte reactive stores for zero-latency UI updates without refetching full process snapshots.
- **Durable Synchronization:** When a turn completes, a durable server snapshot arrives, seamlessly replacing ephemeral text deltas with the final turn record.
- **Scroll Anchoring:** The timeline automatically scrolls to follow live agent output while allowing operators to scroll up to inspect past history without being forced back to the bottom.

---

## 3. Extension UI Renderers

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

Durable leaf-outcome captures reference the same `rendererId`. The UI loads the module from the extension UI catalog and defines the custom element when the Chronicle needs that slot. See [`extensions/local-repo-change`](../extensions/local-repo-change/README.md) for a shipped example (legacy leaf-outcome compatibility renderer).

- **Bounded Insertion:** Custom renderers stay inside Chronicle leaf-outcome hosts; they do not own global shell navigation.
