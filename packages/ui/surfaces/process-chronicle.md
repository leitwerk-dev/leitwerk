# Process chronicle surface

Implemented in [ProcessDetailChronicle.svelte](../src/pages/process-detail/ProcessDetailChronicle.svelte) and the [chronicle components](../src/chronicle/components). Mode: Operate, with a Read flow for process history. This brief covers the chronicle, its decision composer, and the associated waiting state in the turn rail. The page shell and global navigation retain their existing design.

## Job and direction

Operators scan what happened, read the latest result, inspect supporting detail when needed, and choose the next action. Dense history keeps results prominent. Earlier work becomes compact without losing complete short outputs. A separate composer preserves access to the waiting decision while the operator reads away from its detailed form.

The shared entry header establishes the sequence: icon, title and recorded metadata, relative timestamp and duration, then a disclosure control when needed. LLM turns share a sprinkle icon. Metadata uses the recorded model profile and reported cost when available; neither missing usage nor absent turn prompts is filled with sample data. Live turns replace duration with Running or Paused. Turn details belongs at the right of the final card footer.

## Reading history

- Initial prompts remain readable in their own quiet entry. Recorded LLM turn prompts appear as optional, single-line previews that open the full turn details.
- The latest result starts expanded. Earlier rich results start as summaries with Expand result; users can expand or collapse them in place. A historical turn result of at most 240 characters stays complete and compact when it has no recorded turn prompt, line breaks, or block Markdown prefix.
- Result areas use the strongest text and a light accent surface. Create issue belongs to the durable result; compact sentences put it beside Turn details in the footer. Selected-leaf results retain their renderer or Markdown fallback, and capture errors keep their fallback details visible.
- Completed and live cards place Expand reasoning immediately beside Turn details in the final footer, opening the existing reasoning overlay. Omit Expand reasoning when no details exist. Live reasoning previews, open questions, answer forms, and live stop controls remain above that footer.
- Completed startup and preparation collapse by default. Startup retains readiness and completed-check counts in its header. Starting and failed startup attempts open their details; incomplete or failed turn progress stays visible. Expanding completed progress restores ordered checklist detail, while created-change links stay visible outside the disclosure.
- The completed-card footer uses two top-aligned columns. Workspace prepared expands within the left column. Create issue and the detail links remain in the right column. Narrow cards with reasoning put their actions above preparation, keeping Expand reasoning and Turn details together when actions wrap. Preparation expands without moving the links on desktop or mobile.
- External waiting without an operator action belongs to the latest matching turn card. Its collapsed disclosure combines the event count and listener failures; expanded rows keep descriptions, status, and polling details together. The desktop rail and mobile Quick nav show one associated turn with Waiting for an event and an amber clock. It stays outside repeated history and navigates to the embedded disclosure. Scrolling through either the turn or its result selects the same rail row. A wait with no recorded turn remains a standalone section and navigation row.

## Decision composer

The detailed inline action section owns the action form. When available actions are outside the reading viewport, the bottom composer presents the same selection, feedback draft, runtime settings, and preview state. It consumes space below the chronicle scroll area. It is absent while an open question needs an answer.

The composer names the waiting decision and provides View context. The action selector uses the process's available actions, such as Adjust; a suitable text field supplies feedback. Send submits quick feedback using the selected action's accessible label and current runtime options. Actions without a quick field use their own submit label. Options opens scheduling and model controls in the detailed form; actions with complex fields use Open details.

Required-field and submission errors appear inline. Pending submission disables the controls. Switching between the composer and detailed form preserves entered feedback and selection. Command/Ctrl+Enter submits quick feedback. On narrow screens, the action and Options occupy the first row, with feedback and Send below; wide composers place these controls in one row.

## Failed turns and recovery

The current failure's recovery controls sit inside its own recorded turn card. A danger border and small failure badge mark the turn, and the shared Failed message gives the readable cause. The card starts expanded; its header disclosure leaves a compact Failed summary when closed. The body stays mounted while hidden, preserving continuation drafts and model/provider settings. Selecting the failed turn or its recovery anchor through the rail reopens it before scrolling.

Technical details start collapsed. Heartbeat failures explain that the worker stopped responding and state the recorded interval in seconds; the original technical text remains available. The same message treatment serves standalone process and startup errors with their own guidance and recovery controls.

The retry footer explains that retry restarts the turn and exposes Retry failed turn. Supported model and provider settings live in collapsed Retry options. When enough progress was saved, an editable continuation message and Continue from saved work remain available above the footer. Pending work disables controls, unusable model selections prevent submission, and request errors stay inline. Closing either disclosure preserves the entered recovery state.

## States and constraints

Live work keeps its current action, reasoning, question handling, and inline stop confirmation. Recovery, scheduled actions, result-renderer errors, and terminal summaries retain their operational controls. Unknown metadata stays absent. The reference establishes visual hierarchy; real process records determine the content.

The desktop and mobile sandbox evidence covers completed startup, preparation disclosures, a compact historical result, a collapsed rich result, the expanded latest result, result-based issue drafting, and the shared decision draft. A separate question scene covers the live card and answer form. Footer verification at 1458px and 390px confirms that expanding preparation leaves Create issue's position unchanged. No unresolved surface decision remains.
