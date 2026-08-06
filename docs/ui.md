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

## 3. Custom Extension UI Slots

Process extensions can extend the Chronicle timeline by registering custom UI components to render domain-specific turn outputs (such as interactive implementation diffs, test result grids, or review widgets).

### 1. Registering a Custom Renderer in an Extension

An extension registers a UI renderer component during setup:

```ts
// Inside an extension's setup(api) function
api.registerLeafRenderer({
  name: "plan_review_widget",
  displayName: "Interactive Plan Review",
});
```

### 2. Linking a Renderer to a Process Turn

In the process definition, the turn declares `.renderWith(...)` to host the custom component inside its Chronicle timeline slot:

```ts
const planTurn = flow
  .llm<Params, State>("plan")
  .publish("plan")
  .renderWith("plan_review_widget") // Bounded slot in the Chronicle
  .to("human_review");
```

- **Bounded Insertion:** Custom renderers live within designated Chronicle slots, keeping layout and styling consistent across all processes without interfering with global shell navigation.
