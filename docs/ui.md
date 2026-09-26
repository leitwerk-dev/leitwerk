# UI contracts

The UI displays server-owned process state and submits commands. HTTP snapshots
establish durable state; WebSocket frames update live activity or invalidate those
snapshots. This page defines interaction and rendering behavior for contributors.
For everyday use, see [Operate a process](operator-guide.md).

## Chronicle and Turn Rail {#1-chronicle-turn-rail-layout}

Process detail has three regions:

- **Sidebar:** Active and scheduled processes, account controls, and help. Active rows
  show title, status, update time, and current turn. Scheduled rows show their schedule.
  Narrow viewports use a closed-by-default navigation drawer.
- **Turn Rail:** History, current work, and the next turn on the declared happy path.
  Narrow viewports expose it through the process navigation sheet.
- **Chronicle:** Recorded turns, results, live activity, questions, and action forms.

Turn labels and `plannedNextTurn` come from the process definition. Recorded human
outcomes retain the decision taken; absent decision evidence displays Completed,
not an inferred approval. Navigation selection is independent of current process state.

Completed turns use check markers. Running turns use filled blue markers; waiting
turns use amber clocks; future turns use neutral outlines. Failure has an explicit
marker and label. Text and symbols carry state without depending on color.

A process summary shows its full text and update time. Dismiss hides it only for
that process in the current browser, including after reload. **Inspect process → Overview → Show process summary** restores it. If browser storage is unavailable, dismissal lasts
for the current page. This preference never changes process state.

### External waits

A wait belongs to its recorded turn only when that turn is the latest execution.
If another turn has run since, show the current wait after it as a separate section
and navigation row. Never attach a new wait to an old execution merely because
both use the same turn definition. A wait without a recorded turn has its own row.

Listening details are collapsed by default, with event and failed-listener counts.
Expanded details show each description, observation, status, and polling information
together. Failed checks remain visible. Observation timestamps are distinct from
refresh errors. No observation reads **Status not yet observed**.

### Folded history

Consecutive completed cycles may fold into **Earlier updates**, showing sequence,
completed-step count, and recorded decision/event labels. Repeated labels show a
count. Missing labels never imply a cause or successful repair. **History spans**
measures first start to last finish, including gaps; use days and hours beyond a day.
Failed, running, and waiting turns never fold. Keep the latest result next to its decision.

Selecting a hidden turn expands its group. Navigating or scrolling outside the group
collapses it; movement within the group keeps it open. The Chronicle retains the full
history. Arrow keys move among visible rail controls; Enter/Space toggles a group and
Left/Right collapses or expands it. Expansion must not change the rail's width.

Retry history uses explicit parent record IDs, not timestamps or repeated turn names.
Earlier attempts start collapsed. Selecting a historical attempt reveals it; scrolling
alone does not expand retry history. Users may collapse it even while selected.

## Results and turn details {#chronicle-hierarchy}

Turn cards identify the turn, recorded model, time, and duration. Completed LLM cards
share an icon; available cost appears instead of inline token counts. Omit unavailable
cost. **Turn details** opens the complete details; turn cards do not use overflow menus.

Results are more prominent than prompts. Show a prompt row only when input was
recorded; opening it reveals full input. User and Pi custom messages are included,
but custom-message details stay outside displayed input, as they do outside model
context. Full prompts preserve Markdown whitespace; only previews collapse it.

Historical results lead with the supplied summary or a bounded paragraph preview.
**In this result** exposes headings, including validation and limitations, before
expansion. Older reports may use standalone labels before lists. **Read full result**
and **Show summary** switch views. Do not infer validation verdicts from prose or
repeat a summary already at the start of the result.

Keep the latest full result and current recovery controls expanded. Durable results
remain visible even when they match the assistant's final answer. A leaf-outcome
renderer owns its result; do not render a second copy at turn level.

**Show reasoning** and **Turn details** stay together in card footers and use the
same text-link treatment. Missing reasoning adds no empty panel. Current question
forms stay in the Chronicle; turn details contain read-only summaries.

## Process inspector

**Inspect process** replaces the process content region with one inspector. Global
navigation remains available. The Chronicle and Turn Rail stay mounted, hidden and
inert; their drafts and disclosure state survive inspection.

Process sections are **Overview**, **Workflow**, **Inputs & configuration**, and
**Context map**. Overview retains usage coverage, recorded repository facts and
resource links. Source identifiers and project labels link directly to their external
resources. Inputs shows the original request before launch parameters and
mutable model settings. Workflow and step contracts describe the current definition.
They are not a launch-time configuration snapshot. Step links reveal matching
executions in the Chronicle without adding another execution table.

Every execution has **Trace**, **Context**, and **Configuration**. Its persistent
header identifies the record, status and context origin. Trace preserves message
roles, ordered content blocks, tools and operational events. Show reasoning targets
recorded reasoning; prompt links target input. Both use this inspector.

Context separates inherited conversation, supplied product versions and local input.
Source links open the recorded boundary and mark **Context inherited through here**;
activity after that boundary was not inherited. Fresh context excludes inherited
conversation but can still receive products and instructions. The context map shows
recorded conversation and product relationships. Map and List are alternate views
within the evidence pane, both opening at the selected execution. Zoom and Fit map
help navigate large graphs; Show selected restores the selected node at readable size.
Chronological proximity, repeated step names and decision/retry links do not establish
context inheritance. Legacy branch messages with unknown ownership remain readable in
a separate collapsed reference; they are not presented as this execution’s inputs.

Configuration displays retained model-call revisions, effective system prompts,
appended instructions, context files and available tool definitions. Available tools
are distinct from calls made. Evidence states are recorded, not recorded, unavailable,
redacted or not applicable. Current workflow settings remain a separately labelled
reference. Non-model executions omit model configuration and explain its absence.

Inspector URLs select process, step or execution scope and section. Optional entry
and item targets address evidence without transcript text. Explicit navigation pushes
browser history; streaming and scrolling do not. Back retraces an investigation.
**Show in chronicle** reveals the selected execution, including folded history, or
restores the original reading location and focus. Direct and unavailable links retain
navigation. History stores reading and disclosure positions; selection never follows
scrolling or process progress. Keyboard shortcuts are inactive in text fields.

Live Trace starts with Follow live off. New activity is announced without moving the
reader; **Follow live** opts into scrolling and scrolling upward switches it off.
Questions remain read-only summaries here, with links to their canonical Chronicle
forms. Detail reads load only for the selected section. Summary facts can render
before slow expanded evidence, and stale responses cannot replace a new selection.

## Failed work

Recovery controls belong to the failed turn card. Keep the error prominent and
technical details and retry-model settings collapsed by default. Retry explains
that it starts another attempt. Continue is offered only when retained progress
supports it.

Collapsing a card, retry settings, or an action form must preserve entered instructions
and settings. Navigating back reveals the controls. Historical failures remain
visible after recovery; repeated business turns are not retry attempts.

## Live output and reasoning {#4-live-streaming-text-overlays}

The browser displays live output without fetching a full process snapshot for each
update. Durable state replaces the live projection when available. Follow output
only while the reader is already at the bottom; inspecting history must not force
them back to current work.

The inline reasoning preview reserves four wrapped lines and displays the newest
nonblank lines with preceding paragraph context. Short content reserves the same
height. It has a static live indicator and **Show reasoning**, no nested scrollbar
or animation. Full reasoning preserves whitespace.

The initial snapshot contains compact active-turn state, not `TurnTraceSnapshot`.
Do not prefetch detail history on load, hover, idle, or while the inspector is closed.
Opening Trace starts an independent request; slow details must not block the
shell or controls. A direct inspector link also renders the shell first.

Expanded history stays visible through reconnect and turn completion. Loading is
quiet; failures offer inline Retry. Reconnect refreshes full history only while open,
and compact snapshots cannot shorten it. Full history means all server-recorded
activity for the selected turn record. A crash before snapshot upload must not erase
recorded activity. See [WebSocket ordering](websocket.md#reconnect-re-synchronization).

## Progress and startup {#6-turn-progress}

Startup, launch, automatic-turn, and LLM-preparation progress use the same ordered
checklist presentation. Each panel has its own heading. Text and symbols identify
pending, active, completed, failed, skipped, and superseded states. Narrow layouts
wrap labels rather than clipping them. Related links appear under **Created changes**.

Successful startup collapses to its outcome and completed-check count. Successful
preparation becomes **Workspace prepared**, with its ordered checks available on
disclosure. Failed or unfinished checks remain expanded; created-change links stay
visible. Expanding checks does not displace adjacent result actions.

Progress is a reported snapshot. A step still active when an attempt ends displays
**Interrupted** after failure/supersession or **Final status not recorded** after
success. Details preserve the original report; future steps stay incomplete.
Related resources do not establish which attempt created them. Operator and external
events show their recorded time, not a transaction duration; missing attribution
remains unspecified.

### Launch checklist {#7-launch-checklist}

Immediate launch replaces the submit area with a durable checklist and retains the
draft in memory. Navigate when the run gains an `instanceId`; process detail then
shows startup projected from correlated turn-start, worker lease, readiness, and
acceptance records. It never chooses a Launch Run as process-startup evidence.
Scheduled submission saves future work without a startup checklist. See the
[launch HTTP contract](server-worker-lifecycle.md#launch-http-boundary).

The four startup phases are Request worker, Start worker, Prepare runtime, and Start
first turn. Show elapsed time for active phases between updates; stop timers on
completion or failure. Missing observations show unavailable timing, not zero.
Worker-ready duration excludes the subsequent model response wait. Storage, scheduling,
and image startup stay grouped until separately observed.

Timers must not announce every second to screen readers. Status changes do retain
live announcements. Failed attempts remain visible after recovery. Terminal launch
runs collapse to a summary; selecting a failed summary expands it again.

Optional `startup.workerStarts` is diagnostic data, not extra startup UI steps. Its
physical leases, observations, runtime metadata, and clock-labelled intervals retain
missing/invalid durations as null. See [startup observations](server-worker-lifecycle.md#durable-startup-observations).

## Questions and actions

Answer open questions in the Chronicle. Answered and cancelled questions remain
visible through follow-ups and turn completion. Reasoning details show read-only
summaries, even when no trace exists, and never duplicate the answer form.

A new question notifies without changing scroll or focus. Opening the notification
returns from the inspector and focuses the active form. Opening other action
forms focuses the first field without overriding the chosen Chronicle position.

While browsing away from a pending decision, the bottom composer names it and retains
the shared draft. **View context** returns to the action; **Options** opens the
canonical detailed form. Narrow viewports reserve enough visible space for Send.

### Ticket creation {#2-ticket-creation-modal}

**Create issue** operates on a durable result. The initial dialog asks what to create
and selects an adapter only when several are available; it does not preview the
result or request a destination. Opening it does not append a parent-history event.

The server snapshots parent context and sanitized destinations, then admits a derived
draft process. That process resolves ambiguous choices with the operator. External-write
approval displays the resolved destination separately from the tool arguments.

## Interaction and accessibility

Controls have visible keyboard focus and at least 44px button height. Confirmation
buttons name their operation. Dialogs preserve drafts after failed requests. Long
arguments, errors, repository URLs, and paths wrap within the available width.

Chrome, Firefox, and Safari share layout and control styling; Firefox is the visual
reference. Native keyboard, select-menu, and date/time editing behavior remain usable.
Forced-color mode restores native controls. Meaning must not depend on color or icons
alone. Use [browser validation](testing.md#browser-testing) for these behaviors.

### Route scroll ownership

Standard routes have one viewport-level scroller: contained in the desktop shell,
document scrolling on mobile. Pages must not introduce competing viewport overflow
rules. Bounded surfaces such as modal lists and split panes may scroll independently.
Process detail remains contained so the Chronicle owns its timeline scrolling.

Programmatic scroll events must not undo rail selection. Manual scrolling updates
selection when leaving the target. Fragment, relative, and same-origin links use
the current tab. Cross-origin links have a visible external marker, accessible
resource label and new-tab announcement, plus `rel="noopener noreferrer"`.
Managed result images may open in a secured new tab without an external marker.

## Other surfaces

- Watcher cards show purpose, enabled state, process, and target before configuration.
- [API token management](api-tokens.md) lives in the account menu. Anonymous mode shares
  one token owner and omits logout; authenticated logout ends only the browser session.
- [Local session transfer](operator-guide.md#transfer-a-session-to-local-pi) presents the
  full bearer link, expiry, and download warning. Progress never implies that delivered
  bytes can be recalled.
- [Extension renderers](extension-ui.md) remain bounded to their supported slots.

The process inspector's **Inputs & configuration → Model defaults and overrides**
section provides an inline **Edit models** form for nonterminal processes. It uses
server previews, shows inherited choices and marks fixed system models read-only.
**Save changes** applies only edited values to future executions, including scheduled
actions that inherit settings. **Cancel** discards the draft. Live process updates
and failed requests retain unsaved edits; saving disables duplicate submissions and
refreshes process details. Active execution labels continue to show recorded models.

## Settings

Settings in the navigation edits shared Instance and Repository defaults declared
by extensions. Fields show effective values and sources, with Override and Use
inherited value controls. Instruction overrides can append or replace inherited
blocks and show a combined preview. Drafts survive validation errors and conflicts.
A conflict displays the current value before the operator adopts its revision.
Process inspection separates future scoped defaults from captured start history
and links to repository settings. See [Scoped settings](scoped-settings.md).
