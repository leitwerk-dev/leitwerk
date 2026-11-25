# UI contracts

The Svelte 5 SPA (`packages/ui`) renders server-owned state from HTTP snapshots and updates incrementally from [WebSocket frames](websocket.md). This page defines architectural UI contracts for maintainers; for user workflows, see [Operate a process](../users/operate-processes.md) and [Settings](../users/settings.md).

## Routes and shell

| Route | View |
| --- | --- |
| `/` | Dashboard (`GET /api/dashboard`: definitions, watchers, skills, retained process counts combining `Discovered` + `Active` as Running and excluding future/deleted records, estimated USD costs showing partial or unavailable instead of `0` when telemetry is missing, and cached model configuration issues; refreshes on entry, reconnect, tab return, manual refresh, and every 30s while visible). |
| `/processes/new` | Process gallery and `GenericLauncher` (`/config`, `/system`, and `/?launcher=…` forward here). |
| `/processes` | Searchable, filterable, sortable table of current, scheduled, and terminal records. |
| `/processes/:instanceId` | Process detail (Turn Rail, Chronicle, and optional `?inspect=…` Process Inspector). |
| `/future-launches/:futureExecutionId` | Scheduled launch inspection, editing, and cancellation. |
| `/wiki`, `/wiki/:topicId/:pageId` | Solution wikis hosted via `@leitwerk-dev/wiki/ui/WikiPage.svelte`. |
| `/settings` | Scoped settings (`?scope=…`, URL-persisted collection filters and editor state). |
| `/skills`, `/skills/installed/:id`, `/skills/available/:repo/:id` | Installed, Bundled, and Remote skill catalog. |
| `/watchers` | Read-only configured watcher registrations. |
| `/account/api-tokens` | Personal (or shared anonymous) API token management. |

When OIDC claims are retained, the account menu exposes **User information** (`GET /api/auth/user-information`, last-login snapshot; omitted for GitHub and anonymous mode).

## Launcher readiness and admission

- Process gallery cards stay openable when blocked or partially ready so operators can inspect remediation.
- `GenericLauncher` evaluates readiness and form validation via server endpoints (`readiness`, `validate`) without running external connectivity probes or mutating drafts on failure. Text and number inputs debounce 300ms after typing; blur and select changes validate immediately, and background validation never moves focus.
- Immediate launches create a `LaunchRun` checklist and navigate once `instanceId` exists; process detail projects startup across four phases (`Request worker`, `Start worker`, `Prepare runtime`, `Start first turn`) from correlated `TurnStartRecord`, `WorkerLease`, readiness, and accepted-turn records—never from `LaunchRun` alone—keeping elapsed timers silent to screen readers. Scheduled launches (`once` / `cron`) save without creating a `LaunchRun`.

Model selects use native option groups (Free, Economy, Standard, Premium, Other models) with stable profile-ID ordering. Turn controls use the server's turn-specific catalog. A missing or excluded saved selection is not silently reset to Automatic. Launcher previews explain skipped preferences and show readiness errors before admission, including errors on optional branches. Availability stays separate from eligibility; an unavailable winner is not substituted. Show **Why unavailable?** only when the chosen profile is missing, excluded, or unavailable, or automatic selection has no usable candidate.

## Chronicle and Turn Rail

Process detail preserves three regions on desktop (Turn Rail + Chronicle inside the process workspace; sidebar globally) and adapts Turn Rail into a quick-navigation sheet on narrow viewports. The Chronicle and Turn Rail remain mounted while hidden/inert during inspection so form drafts and disclosures survive.

- **Initial pagination:** Loads the most recent 40 turns; **Load earlier steps** pages older history without delaying route switches.
- **Folding:** Consecutive completed cycles may fold into **Earlier updates**; failed, running, and waiting turns never fold. Mapped LLM turn items never fold into each other; only retries of the same item fold into **Earlier attempts** using explicit `parentTurnRecordId` links.
- **External waits:** Attach to a recorded turn only when that turn is the latest execution; otherwise render as a standalone pending section/row.
- **Lazy execution evidence:** Initial snapshots carry compact summaries, never `TurnTraceSnapshot`. Inline reasoning previews reserve a fixed 4-line height without a nested scrollbar or animation. Full Trace, Context, and Configuration load only when requested in the Inspector—never prefetched on load, hover, idle, or while the Inspector is closed.
- **Recovery and questions:** Recovery controls (`Retry`, `Continue`, startup recovery) stay on the failed turn or standalone error section without changing `selectedTurnId`. Open `ask_questions` forms and ticket approvals (`Review issue`) resolve inline in the Chronicle; Inspector views show read-only summaries linking back to the Chronicle.
- **Scoped summaries:** Process summary dismissal is browser-local preference (`localStorage`), restorable from Inspector **Overview**.

## Process Inspector

**Inspect process** (`?inspect=process|step|execution`) replaces the process workspace with a breadcrumb-navigated inspector backed by browser history (`Escape` and **Return to process** restore scroll position and focus).

- **Process scope:** **Overview** (status, usage coverage, repositories, deliverables), **Workflow**, **Inputs & configuration** (original prompt, parameters, inline `Edit models` for nonterminal processes, scoped `ProcessSettings`), and **Context map** (Map and List views of execution inheritance and supplied products).
- **Step scope:** Current workflow definition contracts, declared tools, model policy, transitions, and links to matching Chronicle executions.
- **Execution scope:** **Trace** (opts into scrolling via **Follow live**; scrolling up disables it), **Context** (**Open exact source boundary**, ancestry, supplied products), and **Configuration** (per-call retained system prompt, appended instructions, context files, tools, and explicit `not_recorded` / `redacted` evidence states).

The **Workflow** tab renders `ProcessFlowView` using `@leitwerk-dev/workflow-graph`, the same package used by `npm run dev:workflow-graph`. The primary shortest path to `Completed` forms the main spine; side paths and cycles attach via distinct ports, and mapped LLM turns render as enclosed single activities with an internal collect junction.

## Extension UI and settings boundaries

- **Settings:** Collection tabs use searchable overviews and side-panel editors; overrides use revision-checked `PUT /api/settings/overrides` and preserve drafts on validation errors and 409 conflicts.
- **Extension UI:** Custom leaf-outcome renderers (`leitwerk.ui`) and `BrowserUiExtensionModule` (`registerShortcut`, `registerShellIndicator`, `onWsFrame`) operate only within declared Chronicle and shell slots. Extension UI bundles must not replace navigation or import unresolved bare specifiers (see [UI renderers](../extensions/ui-renderers.md)).

## Accessibility and layout

- Interactive controls maintain visible focus rings and minimum 44px touch targets; state indicators never rely on color alone.
- Standard pages own one viewport scroller; Process detail isolates scrolling inside the Chronicle so Turn Rail and headers stay anchored. Programmatic scroll events must not undo Turn Rail selection; manual scrolling updates selection when leaving the target.
- Cross-origin links render external markers and `rel="noopener noreferrer"`; rendered Markdown is sanitized with DOMPurify.
- Cross-browser validation runs against Chromium, Firefox (visual reference), and WebKit via Playwright.
