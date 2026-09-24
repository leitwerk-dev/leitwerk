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
that process in the current browser, including after reload. **Process info → Show
process summary** restores it. If browser storage is unavailable, dismissal lasts
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
Items of a mapped LLM turn never fold: each item keeps its own card and row, titled with
its label and showing **Item N of M**. While an item runs, the pending row names the next
item. Only retries of the same item group into **Earlier attempts**.

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
Do not prefetch detail history on load, hover, idle, or while its overlay is closed.
Opening reasoning starts an independent request; slow details must not block the
shell or controls. A direct reasoning link also renders the shell first.

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
closes blocking detail overlays and focuses the active form. Opening other action
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
