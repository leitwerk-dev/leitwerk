---
name: Leitwerk UI
description: Calm operational product UI for supervising AI-assisted software delivery processes.
colors:
  canvas: "#ffffff"
  sidebar-surface: "#f7f8fa"
  panel-muted: "#f2f4f7"
  card-surface-strong: "#f8fafc"
  border: "#d9dee5"
  border-strong: "#aeb7c2"
  slate-ink: "#18212b"
  muted-ink: "#4c5968"
  faint-ink: "#687483"
  operational-blue: "#2f61b7"
  accent-soft: "#e6ecf6"
  success-green: "#157a52"
  attention-amber: "#a76313"
  danger-red: "#a83a32"
  danger-ink: "#7d2d27"
  danger-ink-strong: "#5f231f"
typography:
  display:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "normal"
  headline:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 620
    lineHeight: 1.2
  body:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Public Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.08em"
rounded:
  sm: "10px"
  md: "14px"
  lg: "18px"
  xl: "22px"
  pill: "999px"
spacing:
  2xs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
  3xl: "64px"
  4xl: "96px"
components:
  button-primary:
    backgroundColor: "{colors.slate-ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "44px"
  input-default:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  process-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.xl}"
    padding: "24px"
  status-chip:
    backgroundColor: "{colors.panel-muted}"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
---

# Design System: Leitwerk UI

## 1. Overview

**Creative North Star: "Quiet Control Room / Process Chronicle"**

The shell is a quiet control room: a clean, readable product surface where the interface recedes and supervision work becomes obvious. The dominant feeling should be calm operational confidence, close to the cleanliness of ChatGPT or Claude, but with the denser information architecture required for active process supervision.

The chronicle is the signature experience. It should read like a process record with a clear narrative: what started the run, what each turn did, what changed, what needs attention, and what control is available next. Timeline, turn rail, action section, recovery states, and overlays must preserve orientation before adding polish.

This system rejects flashy AI SaaS dashboard styling, dense terminal cosplay, decorative demos, excessive gradients, theatrical motion, ornamental cards, tiny uppercase page kickers, section eyebrows, cryptic status language, and clever affordances that hide recovery paths or next actions.

**Key Characteristics:**

- Calm white and cool-gray surfaces with one operational blue accent.
- Public Sans throughout; no decorative display type in product controls.
- Restrained density: roomy enough to scan, compact enough for supervision.
- Soft tonal layering first; shadows are secondary and functional.
- State and recovery controls are visually explicit, never hidden.

## 2. Colors

The palette is restrained: Slate Ink and cool operational neutrals carry most of the UI, with Operational Blue reserved for selection, focus, links, and current-state emphasis.

### Primary

- **Operational Blue**: The single primary accent. Use it for active navigation, focused chronology, links, selected filters, current rail state, and subtle action-panel tinting. It must stay rare enough to mean “pay attention here.”

### Secondary

- **Calm Success Green**: Use only for completed, successful, or safe terminal states. It should confirm without celebrating.
- **Measured Danger Red**: Use for failed turns, process errors, abort affordances, and recovery blocks. Pair with explicit copy; never rely on red alone.
- **Attention Amber**: Use for waiting, warning, scheduled, or “heads up” states where operator attention may be useful but the process is not broken.

### Neutral

- **Canvas White**: The app’s main working surface. It keeps the UI readable and close to document/workspace tools rather than dashboard theater.
- **Soft Panel Gray**: Secondary panels, toolbar gradients, code surfaces, and quiet empty states.
- **Sidebar Surface Gray**: Navigation background and shell-level grouping.
- **Slate Ink**: Primary text, headings, and high-confidence controls.
- **Muted Ink**: Secondary copy, metadata, helper text, and inactive detail.
- **Faint Ink**: Microcopy, capability badges, timestamps, and low-priority metadata.
- **Cool Border**: Structural separation between panels, rows, and controls.

### Named Rules

**The One Accent Rule.** Operational Blue is the only primary accent. New screens must not introduce purple gradients, neon accents, or competing hero colors.

**The State-Is-Copy Rule.** Color supports state; copy names state. Error, warning, success, scheduled, and waiting states must include readable text labels, not just colored marks.

**The White-Is-Work Rule.** White surfaces are where work happens. Gray surfaces group shell/navigation context; tinted state surfaces are temporary, local, and purposeful.

## 3. Typography

**Display Font:** Public Sans with system sans fallbacks  
**Body Font:** Public Sans with system sans fallbacks  
**Label/Mono Font:** SF Mono / Fira Code only for IDs, counts, compact numeric data, and code-like values

**Character:** This is a single-family product system. Public Sans carries headings, controls, prose, labels, and data with a familiar, civic clarity. Spectral is bundled in the app assets but is not the default product UI voice.

### Hierarchy

- **Display** (700–850, 24–52px on broad page headers, tight line-height): Use sparingly for page titles such as “Start a process” and “All processes.” Avoid excessive negative tracking; the UI must stay readable on narrow screens.
- **Headline** (700, 20px, 1.15): Use for panel titles, overlay titles, and prominent chronicle sections.
- **Title** (620–700, 18px, 1.2): Use for cards, process names, action headers, and row titles.
- **Body** (400–500, 14–16px, 1.5–1.62): Use for descriptions, chronicle content, helper copy, form hints, and status explanations. Long prose should stay around 65–75ch.
- **Label** (700, 11–13px, 0.07–0.08em only for metadata): Use uppercase tracking only for compact status labels and metadata inside components. Never use tiny uppercase kickers above page headings.

### Named Rules

**The Product Sans Rule.** Product UI labels, buttons, rows, data, forms, and navigation use Public Sans. Do not introduce display fonts for controls.

**The Metadata-Only Uppercase Rule.** Uppercase tracking is allowed for status chips, capability hints, and metadata, but forbidden as page-heading scaffolding or decorative section eyebrows.

## 4. Elevation

The system is mostly flat and layered by tone, border, and spacing. Shadows exist, but they are soft and functional: cards lift slightly, overlays separate from content, and toasts float above the app. Ordinary rows, forms, chronicle clusters, and navigation should not become a pile of cards.

### Shadow Vocabulary

- **Soft Surface Shadow** (`0 10px 24px rgba(24, 33, 43, 0.055)`): Use for panels, toasts, and lightweight grouped surfaces.
- **Chronicle Shadow** (`0 18px 40px rgba(24, 33, 43, 0.08)`): Use for elevated cards or heavier foreground surfaces.
- **Process Card Hover Shadow** (`0 24px 52px color-mix(in srgb, var(--chronicle-accent) 13%, transparent 87%)`): Use only for hover/focus on launch cards or equivalent primary selection surfaces.
- **Overlay Shadow** (`0 20px 56px rgba(15, 23, 42, 0.18)`): Use for content-scoped overlays and popovers that must sit clearly above the chronicle.

### Named Rules

**The Tonal-First Rule.** Reach for surface tone, border, and spacing before shadow. If every panel casts a shadow, none of them has hierarchy.

**The Lift-Means-Interaction Rule.** Translate and stronger shadow are for hover, focus, active selection, or temporary overlays — not static decoration.

## 5. Components

### Buttons

Buttons are quiet, rounded, and familiar. They should look like controls, not branding moments.

- **Shape:** Pill for primary/secondary actions (999px radius), compact square-ish icon controls at 9–10px radius.
- **Primary:** Slate Ink fill with Canvas White text, 44px minimum height, 16px horizontal padding, 620 font weight. Use for the next confirming action in a visible action form.
- **Secondary:** Canvas or lightly mixed surface, Slate Ink text, Cool Border stroke, 44px minimum height. Use for refresh, reset, cancel, and supporting actions.
- **Hover / Focus:** Hover may lift by 1px and shift border toward Operational Blue. Focus must use visible outlines or a 3px accent ring. Disabled controls use opacity reduction and no transform.
- **Danger:** Use Measured Danger Red only when the action is destructive; confirmation copy must be inline and explicit.

### Chips

Chips filter, summarize, or annotate state; they are not decoration.

- **Style:** Pill radius, compact padding, cool border, panel-muted or canvas background.
- **Selected:** Light Operational Blue tint with an accent border; keep text Slate Ink or a high-contrast blue mix.
- **Counts:** Counts may use mono or heavier numeric styling when they improve scanning.
- **Capability Badges:** Capability hints are faint micro-labels, not interactive pills.

### Cards / Containers

Cards are used only when the surface is actually selectable or grouped.

- **Corner Style:** 14px for panels and forms, 18px for chronicle/action surfaces, 22–24px for launcher cards.
- **Background:** Canvas White for working surfaces; Soft Panel Gray for secondary context; accent/danger/success tints only for state blocks.
- **Shadow Strategy:** Soft at rest, stronger only on hover/focus or overlays.
- **Border:** Cool Border anchors most containers. Use full borders or tonal fills; never side-stripe accent borders.
- **Internal Padding:** 16px for compact panels, 24px for primary cards/action panels, 32px+ only for broad page rhythm.

### Inputs / Fields

Fields should feel native, readable, and dependable.

- **Style:** 14px radius, 12px by 14px padding, light canvas/panel-muted mix, Cool Border stroke, Slate Ink text.
- **Focus:** 2px Operational Blue outline or equivalent accent ring with 2px offset.
- **Placeholder:** Faint Ink is acceptable only where contrast remains readable; do not use pale gray placeholders.
- **Error / Disabled:** Error fields use Measured Danger Red border, pale danger tint, and explicit error messages. Disabled states reduce opacity and preserve readable labels.
- **Layout:** Split forms may put labels/descriptions left and inputs right, collapsing to one column under narrow containers.

### Navigation

Navigation is a persistent operational shell, not a marketing frame.

- **Sidebar:** Soft gray surface, grouped rows for Current, Future, and Browse. Active rows use subtle Operational Blue tint or stronger border, not loud fills.
- **Collapsed Rail:** Icon controls are standard, compact, and labeled with accessible names. Popovers must remain content-scoped and not clip inside overflow containers.
- **Process Rows:** Expanded sidebar rows are text-first: title, readable state metadata, and optional secondary line. Color only the state word inside the normal metadata flow when scan emphasis is useful; avoid dominant leading status icons, dots, or symbolic badges in front of Current/Future rows.
- **Identity Footer:** Pin the account icon and name below the scrolling navigation. Its compact popover exposes API tokens and keyboard help in both authentication modes. When authentication is enabled, show the authenticated user's name (falling back to the actor id) and Leitwerk-session logout. When authentication is disabled, show “Anonymous” and omit logout. Preserve accessible names and the same behavior in the collapsed rail.
- **Mobile:** Under the narrow breakpoint, expose global navigation as a closed-by-default drawer from a sticky shell bar. Preserve the full navigation hierarchy and identity/help footer, and close the drawer after navigation. Process-local overlays must use another edge so navigation layers remain spatially distinct.

### API Token Management

The account token surface uses the existing Public Sans and chronicle tokens: a quiet white operation form followed by divided metadata rows. Its composition, responsive behavior, temporary secret display, and recovery states are recorded in the [API tokens surface brief](surfaces/api-tokens.md).

### Process Chronicle

The chronicle is the signature component family. Its history is dense, with results carrying more visual weight than prompts, preparation, and reasoning. The [process chronicle surface brief](surfaces/process-chronicle.md) records its reading and decision flow.

- **Turn Rail:** A vertical track with compact markers and readable titles. Active items use accent tint and focus state; completed/terminal states remain calm. Completed and aborted processes always end with a final terminal rail stop. On mobile process detail, replace the persistent rail with a compact Quick nav control and present the rail in a bottom sheet. Keep process info and the overflow actions in that sheet so the chronicle retains the viewport.
- **Timeline Flow:** Prompt, turn cluster, operator input, selected-leaf result, live tail, action, recovery, and terminal summary are distinct section types with shared spacing and borders. The terminal summary should read as a confident endcap, not as weaker metadata below the last turn.
- **Record Surfaces:** History entries use flat bordered surfaces with compact corners (10px), separated by a consistent gap (14px). LLM turns and live work use Canvas White; initial prompts, operator decisions, external events, and automatic work use the stronger cool-gray surface. Typical turn padding is 14px, reducing to 10px below 540px. Result surfaces use a light Operational Blue tint and smaller corners (6px).
- **Entry Header:** Use the shared icon, title/metadata, timing, and trailing-control grid. All LLM turns use the same blue sprinkle icon; operator, system, document, and external entries retain their own symbols. Titles use the body-large scale (15px, 650 weight), with recorded profile and reported cost below (13px). Omit unavailable metadata and keep token counts out of this summary. Relative timestamp and duration share the right-hand area with tabular numerals; the final slot holds startup or failed-turn disclosure controls when needed. Failed entries add a small danger badge to their usual icon. On narrow screens the icon, spacing, and title shrink while this order stays fixed.
- **Results and Supporting Detail:** Expand the latest recorded result by default. Earlier rich results show an expandable summary; a short historical single-paragraph result without a recorded turn prompt stays complete as a compact sentence. Place Create issue on its result, beside the result disclosure or in the footer below a compact sentence. Recorded LLM prompts appear only when available, in a muted one-line row that opens turn details. Completed reasoning remains a quiet Expand reasoning control; live reasoning may show its bounded preview. Keep questions and their answer forms visible, before the final card footer.
- **Card Footer:** Completed and live LLM cards end with Turn details aligned right, opening the existing reasoning overlay. Completed cards use two top-aligned columns: preparation on the left, actions on the right. A compact result places Create issue beside Turn details. Expanding Workspace prepared grows only its column and must not move either footer action. Keep reasoning, questions, and recovery controls above this footer; the live footer also follows stop controls.
- **Action Section:** Light accent-tinted surface attached to the latest relevant context. It must show the next action, scheduling/model implications, validation, and error states inline. Preserve the chronicle's dense record-first structure; do not duplicate the action section into a separate header command strip. While a waiting result is being read away from this section, a compact bottom composer projects the same canonical action-form state, including selection, drafts, runtime options, scheduled edit state, and preview input. Scrolling may switch projections but must never initialize or reset that state. The composer consumes space beneath the scroll viewport and names the waiting decision above the action selector and feedback field. View context returns to the action's context; Options opens the canonical form for scheduling or model selection, and complex fields use Open details. Direct submission uses the current runtime options and shows Send for a quick feedback field. Controls occupy one row when the composer is at least 620px wide; narrower composers pair the action with Options and feedback with Send. Open questions suppress this composer so their answer form remains the active control.
- **Recovery Section:** Embed current failed-turn recovery in its owning turn card, with a danger border, faint danger surface, and the shared Failed message. The header disclosure collapses the body while preserving its continuation draft, model selection, and provider options; rail navigation reopens the failed turn. Technical details start collapsed. Keep the retry footer concise, with Retry failed turn and a collapsed Retry options control for supported model/provider settings. When saved work can resume, show the continuation message and Continue from saved work above that footer. Process and startup errors use the same Failed message with their own guidance and controls. Heartbeat failures show a readable explanation and keep the original technical text available.
- **External Waiting:** When no operator action is available, attach the wait to its latest recorded turn card. The rail uses one row with the turn title, Waiting for an event, and the existing amber clock. Keep that row outside repeated history; selection reaches its embedded waiting disclosure on desktop and mobile. Keep one collapsed disclosure with an event count and failed-listener count. Expanded rows group each event description with its status and polling details; omit the separate Listener details block. A turn without a recorded card uses a standalone waiting section and rail row.
- **Reasoning Overlay:** Content-scoped overlay beside the sidebar, with stronger shadow and clear close/copy/navigation controls.

### Progress checklists

Startup, workspace preparation, delivery, and launch progress share the workspace
preparation row treatment: muted surface, 16px padding, 14px text, static 20px
status marks, and explicit status labels. Use `ProgressChecklist` and
`ProgressChecklistRows`; preserve step details and order. Status labels wrap
beneath their step in narrow containers.

In the chronicle, completed startup attempts collapse to a header with readiness
and completed-check counts; starting and failed attempts open their details by
default. A turn progress report whose steps are all completed collapses to a
quiet success disclosure, labeled Workspace prepared in an LLM turn. Expanding
either restores the shared checklist rows. Incomplete or failed progress remains
fully visible, and links to created changes remain outside the completed-step
disclosure. In a completed LLM card, preparation occupies the left footer column;
Create issue and Turn details stay top-aligned in the right column as its details
expand on desktop and mobile.

### Toasts

Toasts are operator-attention signals, not a diagnostics feed.

- **Style:** 16px radius, soft shadow, calm warning/error tint, readable title and message.
- **Behavior:** Stack distinct toasts, keep them actionable, and allow Escape to dismiss the newest message.
- **Copy:** Use plain-language attention labels such as “Action required,” “Needs attention,” and “Heads up.”

## 6. Do's and Don'ts

### Do:

- **Do** preserve the Quiet Control Room shell: white workspace, cool gray navigation, restrained blue accent, and clear hierarchy.
- **Do** treat the Process Chronicle as the signature surface: chronology, current state, and next control must be unmistakable.
- **Do** keep Operational Blue rare and meaningful for focus, selection, active state, and links.
- **Do** include hover, focus-visible, active/selected, disabled, loading, empty, error, warning, and success states for interactive components.
- **Do** use skeletons or meaningful empty states for loading and no-data conditions; teach what will appear there.
- **Do** maintain WCAG 2.2 AA contrast, keyboard-first operation, readable focus states, and reduced-motion alternatives.
- **Do** use direct, calming recovery copy that tells operators what happened and what to do next.

### Don't:

- **Don't** make the UI feel like a flashy AI SaaS dashboard, a dense terminal cosplay surface, or a decorative demo.
- **Don't** use excessive gradients, theatrical motion, ornamental cards, tiny uppercase page kickers, section eyebrows, or cryptic status language.
- **Don't** hide recovery paths or next actions behind clever affordances.
- **Don't** add a sticky or near-header “Action required” command strip to process detail pages. Keep the inline action section as the canonical detailed decision surface. A compact bottom composer is allowed only while that section is outside the viewport; keep scheduling, model selection, and complex fields progressively disclosed through the inline form.
- **Don't** add gradient text, glassmorphism as default, hero metrics, or repeated identical icon-card grids.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent on cards, list items, callouts, or alerts.
- **Don't** introduce new brand hues without a system-level decision; this product uses one primary accent and semantic state colors.
- **Don't** make inactive states loud with full-saturation color. Inactive means quiet.
- **Don't** invent custom form controls or modal-first workflows when standard inline/progressive patterns are clearer.
