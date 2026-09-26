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

Scalars replace inherited values. Instructions append by default. Replace clears
the inherited instruction blocks, including when the replacement is empty. Reset
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
repository there. Instructions remain separately labelled for every repository.
Retained scope identities allow execution without external rediscovery.

## Execution and history

An LLM turn's `executionPurpose` names an extension declaration that selects the
model setting and required non-secret settings. The internal title-generation
`modelPurpose` remains separate. Ordinary model precedence is documented in
[Models](models.md#profile-resolution).

Preparation resolves the model and settings together before yielding. Each new
`TurnStartRecord`, including an operator retry, captures values, contributing
scopes, schema versions, and override revisions. Workers receive this snapshot and
expose it as `ctx.scopedSettings`; declared instruction blocks join the system
instructions. Prepared starts, active turns, worker recovery, and external-write
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
| `GET /api/settings/scopes` | Retained subjects, including inactive scopes. |
| `POST /api/settings/scopes/refresh` | Refresh configured, retained, and integration-discovered subjects. |
| `GET /api/settings/preview?subjectId=…` | Effective and inherited values, sources, revisions, and validation errors. |
| `POST /api/settings/preview` | Resolve a proposed override using the execution resolver without saving. |
| `PUT /api/settings/overrides` | Set or reset a revision-checked override. |
| `GET /api/settings/processes/:instanceId` | Future scoped defaults and historical captured settings. |
| `PUT /api/settings/processes/:instanceId/primary-repository` | Bind a process project as primary, checking the expected previous binding. |

Instructions default to append when `mode` is omitted. Other fields replace.

An override request carries `subjectId`, `key`, `value`, `mode` (`append` or
`replace`), and `expectedRevision`. Use revision zero for a field never written.
Set `reset: true` to restore inheritance. Resets retain their revision so a stale
editor cannot overwrite a later reset. Successful writes retain the actor and
timestamps. A revision conflict returns HTTP 409; invalid values return HTTP 422.
Preview and update use the same field validation.

The UI keeps drafts on errors and conflicts. On conflict, it displays the current
saved value and requires the operator to accept its revision before resubmitting
the draft. `settings.updated` refreshes future model previews; captured history is
unchanged. Settings are shared across the installation, not per-user preferences.

## Extension contract

`LeitwerkExtensionModule.scopedSettings` declares scope types, settings, and
purposes. Setting keys and purpose IDs use the owning extension's namespace.
Settings have a versioned value schema with `parse`, a default, ordered scopes,
merge behavior, and form metadata. Controls support text, instructions, choices,
model profiles, numbers, and checkboxes. `choices(context)` may supply dynamic
non-secret choices. Validation remains authoritative on the server.

`scopedSettingsCapability` provides a typed server-side resolver and trusted
subject discovery. Discovery callbacks run only during explicit refresh. Launcher
projects may supply `settingsRepository` with a provider origin, repository ID,
and verified aliases. Launchers and integrations may supply `settingsContext` for
registered scopes. Operator forms cannot invent trusted scope bindings.

The coding extension supplies repository instructions and planning,
implementation, and review models. Its README owns those fields. Jira integration
is future work; its named issue-type, project, and compound-scope ordering uses the
same contracts.
