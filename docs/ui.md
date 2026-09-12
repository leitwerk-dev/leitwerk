# UI Architecture & Layout

Process controls use the shared `ui-button` treatment: 44px minimum height,
consistent typography, and visible keyboard focus. Confirmation buttons name
what they do. Process information and reasoning use the same header scale and
Close control. Modal dialogs retain the user's input after a failed request;
issue creation explains that it starts a draft for review before publication.
Reasoning sections and repository details stay within the dialog width. Long
arguments, error messages, repository URLs, and paths wrap on narrow screens.

Startup history, turn progress, and launch progress share `ProgressChecklistRows`.
Expanded turn progress uses the `ProgressChecklist` panel. Rows preserve their recorded order,
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

- **Sidebar:** Left navigation pane listing active and scheduled processes for quick switching. The expanded pane is 240px wide. Active rows show a status dot, title and relative update time above the current turn; each row is limited to two lines with full details on hover. Scheduled rows use a title and schedule line. Its footer shows the current user and a menu for API tokens, keyboard help, and Leitwerk-session logout. When authentication is disabled, it shows Anonymous with API tokens and help; logout is hidden. Narrow viewports expose the same navigation in a closed-by-default drawer from a sticky shell bar.
- **Turn Rail:** Vertical navigation beside the Chronicle, listing completed turns, current work, and its next turn on the declared happy path. Narrow viewports open the same rail in the process navigation sheet.
- **Chronicle:** Main timeline feed rendering live agent reasoning, tool execution logs (bash commands, file diffs), published products, and interactive action controls.

The UI snapshot supplies turn labels from the owning process definition and a
`plannedNextTurn` from its declared happy path, including human decisions.
Recorded outcomes retain the action that was taken. Completed human turns show
the recorded decision, such as Approved or Adjust, beside their elapsed time.
Turns without a recorded decision use Completed. Completed turns use circular
check markers. Running turns use filled blue markers; current
turns awaiting a decision, external update, or scheduled action use filled amber
clock markers. Both keep stronger titles while the operator browses history.
Future turns use neutral outlines. Failed turns retain an explicit error marker
and label. Navigation selection is separate from the process's current state.

External waiting belongs to its latest recorded turn in both the Chronicle and
the rail. That row keeps the turn title and shows Waiting for an event with the
amber clock. Selecting it reaches the embedded waiting disclosure. Scrolling
through the turn or its result highlights the same row. A wait without a recorded
turn keeps its own navigation row.

Consecutive completed cycles fold into **Repeated Turns**, with the sequence,
turn count, and elapsed time from the first start to the last finish. The latest
result stays beside its pending decision. Failed, running, and waiting turns never fold.
Expanding a group reveals ordinary turn rows on the same rail, within a box whose
width stays fixed. The Chronicle retains the full history. Selecting a hidden
turn from the Chronicle or its keyboard navigation expands the containing group.
Scrolling or navigating to a turn outside that group collapses it again;
moving between turns within the group keeps it open. Returning to the group
reveals its history again.
Arrow keys move through visible rail controls; Enter or Space toggles a group,
and Left or Right collapses or expands it.

### Chronicle hierarchy

Completed turns use compact cards with the turn title and recorded model profile beneath it.
LLM cards share one sparkle icon. Reported cost replaces inline token counts; unavailable cost
is omitted. Timestamp and duration stay together at the right of each header, followed by a
reserved disclosure slot. **Turn details** opens the full turn details from the right of the
card footer; chronicle turns do not use overflow menus.

Prompts appear only when recorded, as a subdued row below the header. Selecting the row opens
the full turn input. Input details include user messages and Pi custom messages
(including identified Leitwerk prompts); custom-message details stay outside the
displayed input, just as they stay outside model context. Results use a stronger
surface and typography. The latest result expands
in place; earlier results have a preview and an expand/collapse control. Short historical
outputs without prompts remain plain, complete sentences. Durable results remain visible even
when their text matches the assistant's final answer. A ready leaf outcome still owns its
result rendering, so it does not duplicate the turn result.

**Show reasoning** sits immediately before **Turn details** in completed and live card
footers. Both use the same muted text-link style, without a disclosure chevron.
Missing reasoning adds no empty panel or link. Live reasoning and streamed responses
remain visible above the footer. Turn questions keep their answer forms in the chronicle
and their read-only summaries in turn details.

Successful startup attempts collapse to an outcome and completed-check count. Successful
preparation becomes **Workspace prepared**, with its ordered checks available on disclosure.
Failed or unfinished checks remain expanded; created-change links remain visible. Operator
and external events use the same compact header with quieter surfaces.
Expanding workspace checks leaves the adjacent result actions in their original position.
On narrow cards with a reasoning link, footer actions occupy the first row and workspace
checks expand below them. Show reasoning and Turn details stay together when actions wrap.

When a turn waits for external events and has no operator action, its latest recorded card
contains the waiting status. A single collapsed disclosure shows the event count and any
failed-listener count. Expanding it shows each event's description, status, and polling
details together. If the selected turn has no recorded card, the waiting section remains
at the end of the chronicle. Operator decisions keep their separate action surface.

A failed turn contains its recovery controls in the same card. Its header retains the turn
icon, recorded metadata, timestamp, and duration, with a failure marker and disclosure.
The failure message is prominent; technical details and retry model settings are collapsed
by default. Retry explains that it starts a new attempt. Continuation remains available only
when saved progress supports it. Collapsing the card or retry options preserves entered
instructions and settings; navigating to the failed turn reveals its controls again.

**Create issue** is an action on a durable result. Opening ticket creation does not append an
issue-creation event to the parent history. While browsing away from a pending action, the
separate bottom composer names the required decision and retains the shared action draft.
**View context** returns to the current action; **Options** opens its canonical detailed form.
On narrow viewports, the chronicle reserves visible space for the composer, including Send.

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

Question requests appear inside their turn's supporting detail section. Open requests are answered in
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
Startup rows retain observed phase durations: Request worker, Start worker (allocation through
connection), Prepare runtime (workspace, tools and provider), and Start first turn. The active phase
and overall startup show elapsed time even between server updates. Completed and failed phases
stop their timers. Missing historical observations show unavailable timing, never a fabricated zero.
Storage provisioning, scheduling and image startup remain grouped until separately observed.
Worker-ready duration excludes the subsequent model response wait. The timer text does not trigger
screen-reader announcements every second; status changes retain their live announcements.
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

The inline reasoning preview reserves four wrapped text lines at a fixed height. It shows the newest nonblank lines, retaining preceding paragraph context as new text arrives. Short content uses the same reserved height. Token updates are continuous, with one subdued static live indicator and an Show reasoning control. The preview has no nested scrollbar, animation, or hidden-history footer. Full reasoning preserves original whitespace.

The initial snapshot carries a compact active-turn type, separate from `TurnTraceSnapshot`. The browser retains bounded inline state while the overlay is closed and never prefetches detail history. Opening the overlay starts an independent request; a slow request cannot block the page shell or controls. Reconnect refreshes full history only while the overlay remains open.

Expanded history remains visible during recovery and turn completion. A quiet loading status reports recovery; actual failures offer an inline Retry action. The overlay preserves the reader's position and follows new output only while the reader is already at the bottom. Full history means all server-recorded activity for the selected turn record. A finished turn without a session preview uses its persisted compact summary, so a worker crash does not replace recorded reasoning with an empty preview.

The process UI snapshot API optionally includes `startup.workerStarts` for timing
analysis. Each entry identifies a physical lease and its initial accepted turn,
with durable observations, non-secret runtime metadata and clock-labelled
intervals. Missing endpoints and invalid ordering have null durations. Source
precision accompanies Kubernetes observations; binding timestamps are sampling
bounds. This diagnostic collection does not change the four-step startup UI.
