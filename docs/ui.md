# UI Architecture & Layout

Process controls use the shared `ui-button` treatment: 44px minimum height,
consistent typography, and visible keyboard focus. Confirmation buttons name
what they do. Process information and reasoning use the same header scale and
Close control. Modal dialogs retain the user's input after a failed request;
issue creation explains that it starts a draft for review before publication.
Reasoning sections and repository details stay within the dialog width. Long
arguments, error messages, repository URLs, and paths wrap on narrow screens.

Startup history and turn progress use `ProgressChecklist`; the launch checklist
uses the same `ProgressChecklistRows`. Rows preserve their recorded order,
labels, details, and states. Text and static symbols identify pending, active,
complete, failed, skipped, and superseded steps. Each startup-history and
turn-progress checklist is labelled by its own heading. Narrow containers wrap
status labels below their step text.

Waiting processes show the events that can continue them. Listening details are
collapsed by default; failed checks remain visible. Watcher cards show their
purpose, enabled state, process, and target before configuration details.

The Leitwerk user interface provides real-time visibility and steering control over running AI workflows. This guide explains the three core UI concepts: the Chronicle timeline and Turn Rail layout, live streaming text overlays, and custom extension UI slots.

---

## 1. Chronicle & Turn Rail Layout

The process detail view is organized into three distinct visual regions:

- **Sidebar:** Left navigation pane listing active and scheduled processes for quick switching. Its footer shows the current user and a menu for API tokens, keyboard help, and Leitwerk-session logout. When authentication is disabled, it shows Anonymous with API tokens and help; logout is hidden. Narrow viewports expose the same navigation in a closed-by-default drawer from a sticky shell bar.
- **Turn Rail:** Right-hand outline listing completed turns, active execution leaves, and declared future turns for jumping directly to specific steps.
- **Chronicle:** Main timeline feed rendering live agent reasoning, tool execution logs (bash commands, file diffs), published products, and interactive action controls.

Turn input details include user messages and Pi custom messages (including
identified Leitwerk prompts). Custom-message details stay outside the displayed
input, just as they stay outside model context.

### Route scroll ownership

`RouteViewport` owns scrolling for every standard route. It provides a contained route scroller in the fixed desktop shell and yields to document scrolling below the mobile shell breakpoint. Route pages must not add competing viewport-level `overflow` or `overscroll-behavior` rules. Nested task surfaces such as the Chronicle, modal lists, and desktop split panes may own bounded scrolling.

Process detail is a workspace route. Its `RouteViewport` remains contained so the Chronicle can own timeline scrolling.

Markdown fragment links such as `#details` navigate within the current page. Links to other pages
open a new tab with `noopener noreferrer`.

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

Question requests appear inside their turn's reasoning section. Open requests are answered in
the Chronicle; answered and cancelled requests remain visible while follow-up questions are open
and after the turn ends. The reasoning-details overlay shows read-only question summaries even
when the turn has no recorded trace, and does not duplicate the answer form. Live question
updates refresh the current process view without a browser reload.
New requests, including follow-ups, notify the operator through a question toast without changing
their scroll position or focus. Opening that notification closes blocking detail overlays and
focuses the active question form.

## 3. Local session transfer

A process with a primary Pi session exposes **More actions → Create local transfer link**. Link creation is explicit and never starts export work. The panel presents the complete bearer URL for copying, a one-hour expiry, and a warning that anyone holding it can download the retained workspace and conversation.

While local Pi waits for accepted work, scans, or streams, process detail shows the non-secret phase and explains that new manual turns are blocked. An authenticated operator can cancel before streaming finishes. Once all bytes are delivered, process mutations are unblocked; the status remains visible as awaiting local acknowledgement and does not claim that delivered bytes can be recalled.

## 4. Live Streaming Text Overlays

When an AI agent is actively executing a turn, text tokens stream over the WebSocket directly into active Chronicle turn blocks:

- **Ephemeral Text Streaming:** Streaming text deltas append directly to local Svelte reactive stores for zero-latency UI updates without refetching full process snapshots.
- **Durable Synchronization:** When a turn completes, a durable server snapshot arrives, seamlessly replacing ephemeral text deltas with the final turn record.
- **Scroll Anchoring:** The timeline automatically scrolls to follow live agent output while allowing operators to scroll up to inspect past history without being forced back to the bottom.

---

## 5. Extension UI Renderers

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

## 6. Turn progress

Automatic turns and LLM preparation phases may expose a durable ordered progress report in their
Chronicle cluster. Process startup history uses the same checklist layout, typography, spacing,
and status treatment as these progress reports. The UI names every step state, highlights the
current step, preserves failed steps beside generic recovery controls, and lists created pull
requests, merge requests, commits, or pipelines under **Created changes**. Historical reports
remain part of their owning turn attempt. Status text and symbols carry the meaning without
relying on color.

## 7. Launch checklist

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

The launch-run route accepts only `schedule.mode = "now"`; the future-launch route accepts only
`"once"` and `"cron"`. Other modes return `400` before admission. Updating a future launch to
`"now"` admits a launch run and repeats launcher preparation checks. The future launch is consumed
atomically with process creation; a preparation failure preserves it for a later revision or run.

## API tokens account page

Open **API tokens** in the account menu or visit `/account/api-tokens`. Create a
named token with the configured default expiry, a chosen local date/time, a
30-minute expiry, or no expiration when allowed. The new secret is displayed
once with explicit copy feedback. Save it before dismissal or leaving the page;
reloading cannot retrieve it.

The list shows public ID/prefix, name, creation, expiry, last use, and revocation
status. Revoke individually or confirm revocation of all current-owner tokens.
Listing and revocation remain usable when issuance is disabled. In anonymous
mode, every visitor shares and manages the same token list.

## Reasoning preview and expanded history

The inline reasoning preview reserves four wrapped text lines at a fixed height. It shows the newest nonblank lines, retaining preceding paragraph context as new text arrives. Short content uses the same reserved height. Token updates are continuous, with one subdued static live indicator and an Expand reasoning control. The preview has no nested scrollbar, animation, or hidden-history footer. Full reasoning preserves original whitespace.

The initial snapshot carries a compact active-turn type, separate from `TurnTraceSnapshot`. The browser retains bounded inline state while the overlay is closed and never prefetches detail history. Opening the overlay starts an independent request; a slow request cannot block the page shell or controls. Reconnect refreshes full history only while the overlay remains open.

Expanded history remains visible during recovery and turn completion. A quiet loading status reports recovery; actual failures offer an inline Retry action. The overlay preserves the reader's position and follows new output only while the reader is already at the bottom. Full history means all server-recorded activity for the selected turn record. A finished turn without a session preview uses its persisted compact summary, so a worker crash does not replace recorded reasoning with an empty preview.
