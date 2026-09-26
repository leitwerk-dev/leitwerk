# Settings surface

Mode: Operate. Implemented in [SettingsPage.svelte](../src/pages/SettingsPage.svelte) and [SettingsField.svelte](../src/components/SettingsField.svelte), reached through Settings in global navigation. The surface extends the existing [design system](../DESIGN.md). Resolution and execution behavior are defined in [Scoped settings](../../../docs/scoped-settings.md).

## Purpose and direction

Operators choose a shared scope, inspect effective values and their sources, then save an override or restore inheritance. The introduction states that these defaults are shared across the installation and apply when a new step is prepared, including operator retries. Scope and provenance remain visible so the effect of an edit is clear.

## Composition

Use the incumbent Public Sans, white workspace, cool gray shell, and Operational Blue for focus and saving. The centered page has a maximum width of 860px. Its single column begins with the Settings heading and explanation, followed by Apply settings to and Refresh repositories. Purpose groups follow in extension-defined order; the coding extension supplies Planning, Implementation, Review, and Instructions.

Separate fields with thin horizontal dividers. Each row presents its label and description, Override or Edit override, then the effective value and contributing source. Source labels use muted caption text; values use normal body text. Preserve instruction line breaks and allow long values and source labels to wrap. Keep grouping flat, with a muted inset reserved for the combined instruction preview.

## Editing and feedback

Override opens a labeled inline editor beneath the saved effective value. Focus moves to the value control. Use the declared native input, select, checkbox, number field, or textarea. Model fields name the YAML / catalog default explicitly and retain an unavailable saved selection with a readable label.

Instruction editors place Instruction behavior above the draft. Add to inherited instructions and Replace inherited instructions name the two choices; Combined preview shows the resulting text separately from the editable override. The preview follows the draft without saving it. An empty value remains distinguishable from a runtime default.

Save override is the blue confirming action, with Cancel beside it. Use inherited value is a separate action when an override exists. Pending saves disable the field controls and report Saving…. Successful saves and resets announce their outcome and restore focus to the field's override control; Cancel also restores that focus.

Validation and request errors stay inline and preserve the draft. A revision conflict displays the current saved value with the retained draft and requires Keep draft and use latest revision before saving again. Loading and empty scopes explain their state. Inactive saved settings remain visible with their value and revision and explain that their owning extensions must be installed to edit them.

## Process inspection

[ProcessSettings.svelte](../src/components/ProcessSettings.svelte) appears in the inspector's Inputs & configuration section. It links to Instance and repository settings, keeps Defaults for future steps separate from Captured settings, and uses native disclosures for each step and its instruction blocks. Show contributing sources and recorded revisions with the values. For multiple repositories, expose the primary-repository selector and its save action with the explanation of how unbound model defaults resolve. Background refreshes preserve the selected draft. A binding conflict shows the current saved binding and requires Keep selection and use latest binding before retrying; successful saves announce the result.

## Responsive behavior

At 600px and below, the scope selector and refresh action stack, and each field's override action sits beneath its heading. Editors stay in one column and action rows wrap. Buttons retain a 44px minimum height; interactive controls keep visible blue focus outlines. The existing mobile shell supplies navigation; the form and its combined preview remain in the normal page flow.
