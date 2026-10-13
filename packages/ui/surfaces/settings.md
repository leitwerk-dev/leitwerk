# Settings surface

Mode: Operate. Open Settings from global navigation. The surface follows the [design system](../DESIGN.md). Resolution and execution behavior are defined in [Scoped settings](../../../docs/scoped-settings.md).

## Purpose and direction

Operators choose a shared scope, inspect effective values and their sources, then save an override or restore inheritance. Explain that these defaults are shared across the installation and apply when a new step is prepared, including operator retries. Keep scope and sources visible so the effect of an edit is clear.

## Composition

Use Public Sans, a white workspace, a cool gray shell, and Operational Blue for focus and saving. Instance retains its centered 860px grouped form. Collection tabs expand to 1440px with a searchable overview table and a side-panel editor. The heading, shared-default explanation, and scope tabs remain common to every tab.

Keep Instance first and other groups in declaration order. Offer subjects with declared settings or retained inactive overrides; omit groups with nothing to display. Keep explicitly selected subjects reachable from existing deep links. Repository groups cover every provider. Other collection scopes use the same overview and editor without requiring a scope-specific implementation.

The overview shows name, status, and repository mappings or customized field labels. Repository-mapping metadata comes from the owning extension. Mapping filters are All, Mapped, and Unmapped; other scopes use All, Customized, and Using defaults. Mapped means a nonempty effective repository selection. Resets do not count as customizations. Resolution errors show Needs attention and remain outside unmapped/default filters. Counts cover the selected project, while search narrows visible rows by subject name, repository labels, or customized fields. Component collections offer a project filter. Loading and failed reads remain distinguishable from empty mappings.

Selecting a row opens its editor beside the table. The row is highlighted and focus moves to the editor heading. Close returns focus to the row when it is still visible. Next unmapped component advances through entries matching the current project and search. Saves update overview counts through the shared settings event while retaining selection and drafts. Refresh sources preserves open drafts and reports discovery errors separately.

Selecting a tab or subject updates `/settings?scope=<subjectId>`. Search (`q`), status (`filter`), project (`project`), and closed editor (`view=overview`) are URL state. Shared links, reloads, and browser Back/Forward restore the view. Tab switching remembers each group's filters and last selected subject while the page is open and initially shows its overview. Arrow keys, Home, and End move tab focus; Enter or Space activates the focused group.

Separate fields with thin horizontal dividers. Each row presents its label and description, Override or Edit override, then the effective value and contributing source. Source labels use muted caption text; values use normal body text. Preserve multiline values and allow long values and source labels to wrap. Keep grouping flat, with a muted inset reserved for the group preview.

## Editing and feedback

Override opens a labeled inline editor beneath the saved effective value. Focus moves to the value control. Use the declared native input, select, checkbox, number field, or textarea. Multi-select editors use a search field and native checkbox rows; selected entries stay visible while filtering, including unavailable saved selections. Model fields name the YAML / catalog default explicitly and retain an unavailable saved selection with a readable label.

Overrides replace the inherited value. An empty value remains distinguishable from a runtime default.

Save override is the blue confirming action, with Cancel beside it. Use inherited value is a separate action when an override exists. Pending saves disable the field controls and report Saving…. Successful saves and resets announce their outcome and restore focus to the field's override control; Cancel also restores that focus.

Validation and request errors stay inline and preserve the draft. A revision conflict displays the current saved value with the retained draft and requires Keep draft and use latest revision before saving again. Loading and empty scopes explain their state. Inactive saved settings remain visible with their value and revision and explain that their owning extensions must be installed to edit them.

Remote options load separately from effective values. The editor remains open and
usable during option discovery, announces Loading options, and offers Retry options
after a failure. Searches retain checked choices and discard stale responses.
Search-only fields display saved selections and a search prompt; opening the page
or editor does not fetch options. Queries below the declared minimum make no
request. Matching requests are debounced and announce Searching; failed searches
offer Retry search without losing checked entries.

### Named selection lists

Groups retain their identity as names and members change. Each group uses a flat,
divided fieldset with an editable required Group name, native checkbox rows, an
announced selected count, and Remove group. Add group creates an empty group and
focuses its name; removing a group returns focus to Add group. The empty state
explains how to add, name, and populate a group.

Place one shared search above all groups, using the deferred search behavior
above. Retain selected members across searches and show unavailable saved members
with readable identity labels so they can still be identified and removed. When
a completed search has no additional unselected matches, announce No additional
matches. Try a different search. Keep retained selections visible alongside that
status.

Show one Group preview beneath the complete list, with each draft group and its
members on a separate line. It updates without saving and remains separate from
the saved effective value. Save override commits the complete list; Cancel,
Use inherited value, and revision conflicts follow the shared field behavior
above, preserving the draft during errors and conflict recovery.

## Process inspection

The inspector's Inputs & configuration section links to Instance and repository settings. Keep Defaults for future steps separate from Captured settings, with native disclosures for each step and its captured values. Show contributing sources and recorded revisions with the values. For multiple repositories, expose the primary-repository selector and its save action, and explain how unbound model defaults resolve. Background refreshes preserve the selected draft. A binding conflict shows the current saved binding and requires Keep selection and use latest binding before retrying; successful saves announce the result.

## Responsive behavior

At 700px and below, the search and project controls stack and opening an editor replaces the table with a full-width panel. The page heading, tabs, and overview controls recede until Close returns to the overview. Close returns to the filtered overview. On intermediate widths, the open panel keeps component name and status visible in the table; repository details remain in the editor. Scope tabs wrap at 600px, field actions stack, and long names and values wrap without horizontal page overflow. Buttons retain a 44px minimum height and visible focus outlines.

Named selection lists stack Group name and Remove group at 600px and below.
Group-name inputs, checkbox rows, and buttons retain a 44px minimum height. Long
group names, member labels, and Group preview values wrap within the available
width; save actions wrap as needed.
