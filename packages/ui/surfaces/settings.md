# Settings surface

Mode: Operate. Open Settings from global navigation. The surface follows the [design system](../DESIGN.md). Resolution and execution behavior are defined in [Scoped settings](../../../docs/scoped-settings.md).

## Purpose and direction

Operators choose a shared scope, inspect effective values and their sources, then save an override or restore inheritance. Explain that these defaults are shared across the installation and apply when a new step is prepared, including operator retries. Keep scope and sources visible so the effect of an edit is clear.

## Composition

Use Public Sans, a white workspace, a cool gray shell, and Operational Blue for focus and saving. The centered page has a maximum width of 860px. Its single column begins with the Settings heading and explanation, followed by visible scope tabs, Apply settings to, and Refresh sources. Tabs separate Instance, Repositories, and extension-declared groups such as issue projects and components. The native selector contains only entries in the active group, sorted by label. Purpose groups follow in extension-defined order.

Keep Instance first and other groups in declaration order. Offer subjects with declared settings or retained inactive overrides; omit groups with nothing to display. Preserve an explicitly selected subject so existing deep links still explain empty scopes. Retained overrides from an unavailable extension remain reachable under their scope ID and an inactive label. Repository groups cover every provider without guessing brands from repository labels. A scope deep link selects its group; switching groups remembers the last selected entry while the page is open. Refresh preserves the selected identity and open drafts, including redirected repository identities. Arrow keys, Home, and End move tab focus; Enter or Space activates the focused group.

Separate fields with thin horizontal dividers. Each row presents its label and description, Override or Edit override, then the effective value and contributing source. Source labels use muted caption text; values use normal body text. Preserve instruction line breaks and allow long values and source labels to wrap. Keep grouping flat, with a muted inset reserved for the combined instruction preview.

## Editing and feedback

Override opens a labeled inline editor beneath the saved effective value. Focus moves to the value control. Use the declared native input, select, checkbox, number field, or textarea. Multi-select editors use a search field and native checkbox rows; selected entries stay visible while filtering, including unavailable saved selections. Model fields name the YAML / catalog default explicitly and retain an unavailable saved selection with a readable label.

Instruction editors place Instruction behavior above the draft. Add to inherited instructions and Replace inherited instructions name the two choices; Combined preview shows the resulting text separately from the editable override. The preview follows the draft without saving it. An empty value remains distinguishable from a runtime default.

Save override is the blue confirming action, with Cancel beside it. Use inherited value is a separate action when an override exists. Pending saves disable the field controls and report Saving…. Successful saves and resets announce their outcome and restore focus to the field's override control; Cancel also restores that focus.

Validation and request errors stay inline and preserve the draft. A revision conflict displays the current saved value with the retained draft and requires Keep draft and use latest revision before saving again. Loading and empty scopes explain their state. Inactive saved settings remain visible with their value and revision and explain that their owning extensions must be installed to edit them.

## Process inspection

The inspector's Inputs & configuration section links to Instance and repository settings. Keep Defaults for future steps separate from Captured settings, with native disclosures for each step and its instruction blocks. Show contributing sources and recorded revisions with the values. For multiple repositories, expose the primary-repository selector and its save action, and explain how unbound model defaults resolve. Background refreshes preserve the selected draft. A binding conflict shows the current saved binding and requires Keep selection and use latest binding before retrying; successful saves announce the result.

## Responsive behavior

At 600px and below, scope tabs wrap into two columns, the scope selector and refresh action stack, and each field's override action sits beneath its heading. Editors stay in one column and action rows wrap. Buttons retain a 44px minimum height; interactive controls keep visible blue focus outlines. The existing mobile shell supplies navigation; the form and its combined preview remain in the normal page flow.
