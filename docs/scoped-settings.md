# Scoped settings

Scoped settings store installation-wide, non-secret overrides in SQLite. Extensions
declare fields, validation, scope order, defaults, merge behavior, and execution
purposes. Core owns storage, resolution, and generic forms. Credentials and
deployment wiring remain in their existing configuration mechanisms.

## Resolution

Each field declares its scopes from least to most specific. Repository settings
use code/runtime defaults → Instance → Repository. Named compound scopes are
registered explicitly; there are no arbitrary matching expressions. A compound
subject retains the lower-scope identities supplied by its integration.

Overrides replace inherited values. Reset
removes the override's effect and restores inheritance. Empty, null, and absent
overrides remain distinct. A nullable model default delegates to YAML and the
allowed catalog fallback; it does not pin a model profile.

Repository subjects come from configured components, retained process projects,
and explicit integration discovery. A provider origin and stable repository ID
identify a provider repository; verified clone URLs are aliases. A local or
unrecognized repository uses its normalized locator. Core does not guess that
different transports, paths, or symlinks identify the same repository. Discovery
can promote locator subjects to one verified provider identity without losing
their overrides. Old scope IDs continue to resolve through retained redirects;
prepared snapshots remain unchanged. Merging advances override revisions so an
open editor must accept the current revision before saving. Matching overrides
are retained once. Conflicting values block merging and identify the scopes to
correct: make the overrides agree or reset one to inheritance, then refresh.
Distinct provider identities are never merged.

A launcher may bind `primaryRepositoryKey`. Single-repository launches infer their
primary repository. Unbound multi-repository processes use Instance model defaults
and explain that choice in process inspection. Operators can bind a primary
repository there.
Retained scope identities allow execution without external rediscovery.

## Execution and history

An LLM turn's `executionPurpose` names an extension declaration that selects the
model setting and required non-secret settings. The internal title-generation
`modelPurpose` remains separate. Ordinary model precedence is documented in
[Models](models.md#profile-resolution).

Preparation resolves the model and settings together before yielding. Each new
`TurnStartRecord`, including an operator retry, captures values, contributing
scopes, schema versions, and override revisions. Workers receive this snapshot and
expose it as `ctx.scopedSettings`. Settings do not add instructions to model prompts.
Prepared starts, active turns, worker recovery, and external-write
replay retain their captured inputs. Scheduled work resolves current defaults at
dispatch. Settings edits refresh inherited scheduled model selections and their
availability blocks. Explicit scheduled choices remain in effect. Settings edits
do not mutate historical starts or live worker inputs.

Removing an extension retains its subjects and overrides. The Settings page shows
unregistered fields as inactive. Reinstallation restores compatible fields. A
schema-version mismatch or invalid stored value blocks affected preparation with
the setting key and correction instructions. Explicit model selections still pass
the process allowlist and model-availability checks.

## Operator API

All endpoints use the application's authenticated actor and authorization model.

| Endpoint | Contract |
| --- | --- |
| `GET /api/settings/definitions` | Active extension definitions and form metadata. |
| `GET /api/settings/scopes` | Retained subjects visible to configured discovery, including inactive scopes. |
| `GET /api/settings/overview?scopeType=…` | Locally resolved summaries for one collection scope, including mappings, active overrides and errors. |
| `POST /api/settings/scopes/refresh` | Refresh configured, retained, and integration-discovered subjects. |
| `GET /api/settings/preview?subjectId=…` | Effective and inherited values, sources, revisions, and validation errors; does not wait for remote options. |
| `GET /api/settings/choices?subjectId=…&key=…&search=…` | Dynamic options for one field, including retained saved selections. |
| `POST /api/settings/preview` | Resolve a proposed override using the execution resolver without saving. |
| `PUT /api/settings/overrides` | Set or reset a revision-checked override. |
| `GET /api/settings/processes/:instanceId` | Per-turn `future` scoped defaults/errors and historical `captured` settings. |
| `PUT /api/settings/processes/:instanceId/primary-repository` | Bind a process project as primary, checking the expected previous binding. |

Overrides use `replace` mode. Append mode is not supported.

An override request carries `subjectId`, `key`, `value`, `mode` (`replace`), and `expectedRevision`. Use revision zero for a field never written.
Set `reset: true` to restore inheritance. Resets retain their revision so a stale
editor cannot overwrite a later reset. Successful writes retain the actor and
timestamps. A revision conflict returns HTTP 409; invalid values return HTTP 422.
Preview and update use the same field validation.

Settings groups subjects into visible tabs by declared scope type. Instance comes
first, followed by repositories and extension groups such as Jira projects and
Jira components. Collection scopes use a searchable overview and a side-panel
editor; Instance remains a grouped form. Repository-mapping fields declare
`form.overview: "repository-mapping"`; their nonempty effective selections count
as mapped. Other scopes distinguish active overrides from inherited defaults.
Resolution errors remain separate from unmapped/default states. The overview API
resolves compact summaries locally without discovering remote choices.
Selecting a tab or subject updates `/settings?scope=<subjectId>`. Search (`q`),
status (`filter`), project (`project`), and editor visibility (`view=overview`)
are retained in the URL. Shared links, reloads, and browser Back/Forward restore
both the group and exact view. `/settings` opens
Instance. Refreshing sources retains the selection and open
drafts. Subjects without declared fields or retained inactive overrides are omitted
from navigation; an explicitly selected subject remains visible for direct links.
Unavailable scope types with retained overrides remain reachable with an inactive
label. The scopes API reports this distinction as `hasSettings` without discarding
discovered subjects.

The UI keeps drafts on errors and conflicts. On conflict, it displays the current
saved value and requires the operator to accept its revision before resubmitting
the draft. `settings.updated` refreshes future model previews; captured history is
unchanged. Settings are shared across the installation, not per-user preferences.

## Extension contract

`LeitwerkExtensionModule.scopedSettings` declares scope types, settings, and
purposes. Setting keys and purpose IDs use the owning extension's namespace.
Settings combine shared `SettingMetadata` with a versioned value schema and default.
Metadata defines ordered scopes, merging, and forms. Controls support text, multi-line text, choices,
model profiles, numbers, checkboxes, and searchable multi-selects. `choices(context, request)` may supply
dynamic non-secret choices. The optional request contains search text and saved
selection values. Options load separately from value previews, writes, and draft
validation. A multi-select's `form.search` declares a minimum query length and an
optional placeholder. Those fields show saved selections immediately and fetch
matches only while editing a query at or above the minimum; shorter queries return
no matches without calling the provider. `choiceLabel(value)` may label saved
selections synchronously without remote discovery. Validation remains authoritative
on the server.

Scope definitions may declare `overview` display metadata: singular and plural item
names, an optional parent label and a separator in discovered subject labels. The
generic collection view uses these for headings, search and grouping without
depending on an integration's scope ID.

The `named-selection-list` control edits an array of `{ id, name, values }` rows.
IDs remain stable across renames; `values` contains choice identities. All rows
share the field's deferred search and retained labels. Preview, save, reset and
conflict handling operate on the complete list as one override. Adding named
selections does not add a Settings scope or navigation tab.

`scopedSettingsCapability` provides a typed server-side resolver and trusted
subject discovery. `findSubject(scopeType, identity)` reads a retained subject or
returns null without discovery or remote requests. Integrations can retain names
from successful searches with `discover` and use them in synchronous choice labels
after a restart. Discovery callbacks run only during explicit refresh. A discovery
provider may supply `includesSubject` to restrict navigation to configured targets;
subjects and overrides outside that scope remain stored and resolve through direct
links. Launcher
projects may supply `settingsRepository` with a provider origin, repository ID,
and verified aliases. Launchers and integrations may supply `settingsContext` for
registered scopes. Operator forms cannot invent trusted scope bindings.

`getSubject(id)` reads a retained subject by ID. `seedOverride(subjectId, definition,
value)` initializes a never-written override through normal server validation and
revision checking. It returns false when an override or explicit reset exists;
seeders must not replace operator decisions.

The resolver's `SettingsContext`, `SettingsSubject`, and `ResolvedSetting` values
are supported extension contracts. Resolved values include `SettingsSource`
metadata identifying the contributing subject, scope, schema version, revision,
and merge mode. Workers receive the supported `ScopedSettingsSnapshot` contract;
version 1 retains the consumed values for that prepared start. Historical snapshots
may contain retired instruction blocks; workers ignore those blocks. Startup removes
the retired `coding.repository_instructions` overrides while preserving execution history.

The coding extension supplies planning, implementation, and review model defaults.
Extension READMEs own provider-specific scopes
and settings. Multi-select controls retain unavailable selections and drafts across
refreshes and revision conflicts; server schemas remain authoritative.
