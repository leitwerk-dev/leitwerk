# Scoped settings

Scoped settings store installation-wide, non-secret overrides in SQLite. Extensions declare scope types, versioned setting schemas, form controls, discovery providers, and execution purposes; core owns storage, inheritance resolution, and the `/settings` UI. For operator usage, see [Settings](../users/settings.md).

Credentials and deployment wiring do not belong in scoped settings.

## Declaring scopes, settings, and purposes

Expose `scopedSettings: ScopedSettingsDeclaration` (`{ scopes?, settings, purposes? }`) on your `LeitwerkExtensionModule`. Namespace all scope IDs, setting keys, and purpose IDs by your owning extension ID.

| Type | Key fields |
| --- | --- |
| `SettingsScopeDefinition` | `id`, `label`, optional `overview` (singular/plural names, parent label, separator for collection views). Core supplies `instance` and `repository`. |
| `SettingDefinition<T>` | `SettingMetadata` (key, label, scopes least-to-most specific, `form`), `schema: { parse(v): T }`, `defaultValue`, optional synchronous `choiceLabel(value)`, optional `choices(context, request?)`. |
| `ExecutionPurposeDefinition` | `id`, `label`, optional `modelSettingKey` (nullable model setting delegating to YAML/catalog fallback), optional `settingKeys` (only listed keys enter worker snapshots). |

Rules:

- Named compound scopes must be registered explicitly; arbitrary matching expressions are not supported.
- Overrides use `replace` mode (append mode is unsupported); empty, `null`, and absent overrides remain distinct.
- Repository-mapping fields set `form.overview: "repository-mapping"`.

### Supported form controls

Core renders forms from field metadata: text, multi-line text, single select, model profile select, number, checkbox, searchable multi-select, and `named-selection-list`.

- **Dynamic choices:** `choices(context, request)` supplies non-secret options (`request` carries `search` and saved `values`) independently of value previews, writes, and validation.
- **Deferred search:** Set `form.search` with a minimum query length and optional placeholder on multi-selects so saved values display immediately and the provider is queried only when a query meets the minimum length. Implement synchronous `choiceLabel(value)` to label retained selections without remote discovery.
- **`named-selection-list`:** Edits `{ id, name, values }[]` rows with stable IDs across renames, shared deferred search, and retained labels. Preview, save, reset, and conflict detection operate on the full list as one override without adding navigation scopes.
- Server-side schema validation is always authoritative.

## Binding turns with `executionPurpose`

Attach `.executionPurpose(purposeId)` to an LLM or mapped LLM turn to bind a declared `ExecutionPurposeDefinition`:

- Preparation resolves the model and declared settings together when creating each `TurnStartRecord` (including operator retries), capturing values, contributing scopes, schema versions, and override revisions.
- Workers receive the immutable `ScopedSettingsSnapshot` as `ctx.scopedSettings`. Settings never inject text into system prompts automatically.
- Edits to settings affect future starts and inherited scheduled runs; prepared starts, active turns, worker recovery, and external-write replays retain their captured snapshot.
- A schema-version mismatch or invalid stored value blocks preparation with the setting key and remediation details.

Explicit model selections must meet the destination turn's effective requirements and availability checks. An inherited purpose preference can be skipped if policy excludes it; unknown profiles and malformed settings still block. Availability never selects a replacement.

## Server capability and subject discovery

Obtain the server-side resolver in `setupServer`:

```ts
const settings = api.require(scopedSettingsCapability);
```

| `ScopedSettingsResolver` method | Contract |
| --- | --- |
| `resolve(definition, context)` | Resolves the effective `ResolvedSetting<T>` and contributing `SettingsSource` for `context`. |
| `findSubject(scopeType, identity)` | Reads a retained subject without discovery or remote I/O; returns `null` if absent. |
| `getSubject(id)` | Reads a retained subject by ID, including retained redirects. |
| `seedOverride(subjectId, definition, value)` | Initializes a never-written override through normal validation; returns `false` if an override or explicit reset already exists. |
| `discover(input)` | Persists a `SettingsSubjectInput` (`scopeType`, `identity`, `label`, `context?`, `aliases?`) so synchronous `choiceLabel` works across restarts. |
| `registerDiscovery(scopeType, fn, options?)` | Registers an explicit refresh callback (`options.includesSubject` filters navigation without deleting out-of-scope overrides). Never runs during step preparation. |

Discovery and repository identity rules:

- Derive provider repository identities with `repositorySettingsIdentity(origin, repositoryId)` (verified clone URLs are `aliases`). Unrecognized repositories use normalized locators.
- Discovery may promote a locator subject to a verified provider identity: matching overrides deduplicate, conflicting values block promotion until resolved, and distinct provider identities never merge.
- Launchers supply `settingsRepository` on projects (`origin`, `repositoryId`, `aliases`) and optional `primaryRepositoryKey` or `settingsContext`. Operator forms cannot forge trusted scope bindings.

The `SettingsContext`, `SettingsSubject`, `ResolvedSetting`, `SettingsSource`, and `ScopedSettingsSnapshot` types are supported extension contracts.
