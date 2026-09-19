# Leitwerk API explorer prototype

A local, single-user workbench for exploring package exports and their statically
resolved TS/JS usages. It runs independently of Leitwerk. It does not load application
implementation modules or connect to the server, workers, database, or application UI.

Generate a catalog in Leitwerk, then start the independent explorer:

```sh
npm run api:report
npm ci --prefix tools/api-explorer-prototype
npm run dev --prefix tools/api-explorer-prototype
# Optional report collection:
npm run dev --prefix tools/api-explorer-prototype -- --reports-dir /path/to/reports
```

Open **http://127.0.0.1:4318**. The server binds only to localhost and reads JSON
reports. It does not build, index repositories, or discover compositions.
The default directory is the main checkout's `.leitwerk/api-explorer/reports/`,
covered by the root `.leitwerk/` ignore rule. Copy consumer `usage-*.json` reports
there alongside `catalog.json`, then select **Reload reports**. No original source
directory is required. The server exposes only merged data at `/api/reports`;
request parameters cannot select filesystem paths.

Generate again after changing source. `npm run api:report -- --built` reuses a
successful build. Reports atomically replace the preceding source report.
Missing catalogs, invalid JSON, and unsupported schemas appear in coverage diagnostics.
Old snapshots must be regenerated; stable API IDs preserve existing browser notes.

## View links

The header uses bookmarkable links that support opening in a new tab, reloads,
and browser Back/Forward:

- **Explorer:** `http://127.0.0.1:4318/#explorer`
- **Removal candidates:** `http://127.0.0.1:4318/#removal-candidates`
- **Internal API dependencies:** `http://127.0.0.1:4318/#internal-api-dependencies`
- **All notes:** `http://127.0.0.1:4318/#all-notes`

Empty or unknown fragments open Explorer. Links select the top-level view only;
graph focus and filters remain session-local. Notes remain in browser storage,
not in the URL. Opening an API from another view switches the URL to `#explorer`.

## Removal candidates

The table separates **Proposed change**, **Assessment**, and **Observed usage**:

- Changes: **Make file-local**, **Reduce package exposure**, **Consider declaration
  deletion**, or **No reduction established**.
- Assessments: **Candidate**, **Migration required**, **Review required**, or **Retain**.
- Usage describes observed consumers, including imports. **Only test consumers
  observed** is evidence, not permission to delete a declaration.

Filter by change, assessment, constraint, and observed usage; search by name,
package, or action. Counts cover all findings, not just rendered rows. Analysis
uses every loaded report, independently of display filters. Public/preview routes
require compatibility review; missing release metadata requires classification
review. Neither is an automatic removal recommendation.

Findings group declarations, member evidence, and alias routes. Each route has its
own assessment and migration requirements. The aggregate describes potentially
reducible routes; it does not authorize removing retained or unresolved aliases.
Declaration retention and export exposure are separate decisions. Retained
production and test routes remain visible, even when there is no reduction proposal.

Re-exports are exposure wiring. Imports remain visible as dependencies; cross-package
imports protect their used routes even without resolved calls. **Make file-local**
requires all consumer references, including tests and imports, to be in the defining
file. Tests in other files require module access. **Reduce package exposure** does
not mean removing that module export: same-package imports may need rewriting, and
direct-source entry points may need a separate facade. Migration requirements name
the affected occurrence IDs. Cross-package tests protect used routes just like
production consumers; unresolved routes require review.

Constraints identify the affected change and, when known, route or retaining API.
Exported signatures retain the declaration/module export, not necessarily every
barrel route. Declared runtime entries and explicit keep reasons retain their
routes. A default export alone is uncertainty, not proof of runtime use. Initializer
side effects block declaration deletion, not necessarily exposure reduction.
Incomplete, incompatible, or unreadable reports block **every absence-based
proposal**, including file-local and package-exposure changes. Known positive
retention remains valid. Coverage is conservatively global until reports can
reliably localize gaps; no numeric confidence is inferred.
Each row opens the inspector or existing graph/notes. Analysis never writes notes.

**Export findings** downloads all matches for the current search and category,
including rows beyond **Show more findings**. Explorer filters do not affect it.
The version 2 JSON includes repository/report metadata, coverage, diagnostics,
filters, and findings with structured changes, assessments, constraints, retaining
API IDs, route migrations, and declaration source context. Version 1's mixed action
categories have been replaced; consumers must check the version. Findings refer to
shared evidence through `usageIds` and `cleanupIds`; resolve these against the
single top-level `occurrences` array. Each occurrence appears once in the export. Download failures appear
in an error banner; check browser downloads after a successful request.
Coverage means **the loaded sources**, never every possible consumer.

The [development-tools README](../../packages/dev-tools/README.md#portable-api-reports)
documents report generation and supplemental runtime-use/keep evidence.

## Read-only findings API

The development server exposes the same classifier and filtering logic used by the
UI and findings export. Models can inspect findings without a browser or source
checkout. Start with `GET /api/v1/schema` for enum values, fields, filters, and
response contracts. These routes are available through `npm run dev`, not static
hosting of `dist/`.

| GET endpoint | Result |
| --- | --- |
| `/api/v1/findings` | Compact, paginated findings in stable finding-ID order |
| `/api/v1/findings/detail?id=…` | One finding, source snippets, occurrences, retaining APIs, and wiring evidence |
| `/api/v1/findings/summary` | Counts by change, assessment, constraint, and observed usage |
| `/api/v1/findings/export` | All matching findings and normalized evidence, as the UI's version 2 download |
| `/api/v1/schema` | Versioned discovery contract |

List, summary, and export accept `query`, `package`, `change`, `assessment`,
`constraint`, and `scope`. Filters combine with AND. `query` is a case-insensitive
substring; other filters are exact machine codes from `/api/v1/schema`. `package`
matches a declaring/display package or an alias route's package. List accepts
`limit` (1–200, default 50) and an opaque `cursor`. Unknown, duplicate, and invalid
parameters return 400 rather than silently broadening a query.

```sh
curl -s http://127.0.0.1:4318/api/v1/schema
curl -sG http://127.0.0.1:4318/api/v1/findings \
  --data-urlencode 'change=reduce-package-exposure' \
  --data-urlencode 'assessment=migration-required' \
  --data-urlencode 'limit=50'
curl -sG http://127.0.0.1:4318/api/v1/findings/detail \
  --data-urlencode 'id=FINDING_ID'
curl -sG http://127.0.0.1:4318/api/v1/findings/export \
  --data-urlencode 'constraint=incomplete-coverage' > findings.json
```

List/detail/summary responses include `schemaVersion: 1`, `analysisId`, repository,
report metadata, and loaded-source coverage. Lists include `total` and `nextCursor`
(`null` on the last page). Constraints and scopes overlap; summary counts count a
finding once per code, not once per constraint instance. Detail resolves occurrence
IDs and retaining owner IDs; an unavailable owner has `node: null`. Export uses
`version: 2` and adds `analysisId` to the UI export contract.

Pass a returned `analysisId` to any findings endpoint to pin evidence. Cursors pin
both the analysis and filters automatically. Changed evidence or filters return
409 `stale-analysis`; restart from the first page. Reports are loaded on request;
no reload mutation is needed. `analysisId` includes evidence content and classifier
version, not just the repository revision. It is not a persisted snapshot handle.

Errors are JSON: `{ "schemaVersion": 1, "error": { "code": "…", "message": "…" } }`.
Unknown findings/routes return 404, non-GET methods 405, and report-loading failures
500. Responses use `Cache-Control: no-store`. The API binds only to localhost,
reads the configured report directory, accepts no filesystem paths, and cannot
change source files, browser notes, or endorsements.

## Explore

The overview places consumers on the left and their dependencies on the right.
An edge runs from the using package to the package it references. Counts include
imports and re-exports. Imported names follow the package actually imported;
other references follow the member or symbol's declaring package. Shared aliases
and inherited members do not create dependencies on every package exposing them.
Package edge totals and package callers count each source occurrence once per
target package. Older snapshots use declaring packages only; reindex to capture
import routes as well.

- Use the navigation search and package, visibility, and declaration-kind filters.
  Public (including alpha/beta) and internal APIs are initially visible. Tests are hidden.
- **Focus** drills into a package, declaration, or member. Packages connect directly
  to their exports; entry points appear as subpath context on API cards. Breadcrumbs
  and Back/Forward return to earlier views. Selecting a node opens its inspector.
- Public/preview API cards are blue; internal API cards are amber. Text labels and
  visibility filters identify the same classifications.
- **Expand** reveals children and referenced types. **Show more** adds
  the next batch. **Collapse** and **Hide** remove branches from the canvas;
  **Restore hidden** brings hidden nodes back. Navigation remains available.
- **Callers** toggles files that call a package or API and its members. Interfaces
  offer **Usages** instead: type references, member access and calls, imports, and
  re-exports. Usage edges show occurrence counts; select a file to inspect each
  occurrence and its kind. **More usages** adds the next batch of files.
  Both buttons show the total matching occurrence count, including files not yet
  expanded. Counts update with the API, internal-usage, and test filters.
  External usages (outside the API's package) appear by default. **Include internal
  usages** also shows same-package usages or callers for API boxes, after external ones.
  Package boxes always exclude same-package callers, including their tests.
  Caller cards and edges identify external/internal scope; edges show call counts.
  **More callers** adds the next batch. Calls include constructors; imports,
  re-exports, and type references for other API kinds remain in the inspector's usages. Test usages
  follow **Include tests**. Caller scope is independent of public/internal API tags.
- Drag nodes to arrange them. Pan, zoom, fit, and minimap controls operate on the
  current graph. **Auto layout** arranges the visible graph. Packages use a left-to-right dependency hierarchy with space for every
  card. Adding or restoring packages automatically lays out and fits the overview,
  including previously moved cards. Other expansions preserve manual positions
  until **Auto layout** is requested. Actual dependency cycles may have backward
  edges. Positions are session state, separate from the snapshot and notes.
- Select an occurrence in the inspector to see its snippet and **Copy path:line**.
  The occurrence-kind filter distinguishes calls (including constructors), types,
  imports, re-exports, and other references. Paths are relative to the repository.
- Nodes without visible callers explain their role or missing evidence. The inspector
  separates calls, other references, and wiring: default exports, manifest-declared
  extension entries, destructured bindings, and calls to a shared implementation.
  Click wiring evidence for its source. A shared implementation call may use another
  factory instance, so it is never counted as a caller of an exported alias. A declared
  entry does not prove runtime activation. No indexed callers does not mean unused.

The navigation, node actions, and inspector work with the keyboard. The canvas uses
Svelte Flow's keyboard selection and movement. At narrow widths the inspector moves
below the canvas; this prototype is designed for a desktop workbench.

## Internal API dependencies

This view lists cross-package references to APIs classified as internal in the
catalog. Findings are grouped by consumer repository and target package/API. Expand
a finding for caller locations, snippets, routes, and production/test counts.
Select an API to open it in Explorer.

| Assessment | Meaning |
| --- | --- |
| Warning | Explicit internal route, known consumer package, matching package versions |
| Needs review | Ambiguous route, unknown consumer or version, or version mismatch |

A version mismatch does not establish that the consumed API was internal. Explicit
public routes are not attributed to internal aliases. Same-package references are
excluded; shared aliases count each occurrence once.

Filter by repository, target package, assessment, usage scope, or search text.
Scope filters select findings containing production or test references; details
retain both. Explorer filters do not affect this view. Empty results do not prove
absence of consumers, particularly with incomplete coverage or unmatched symbols.

**Export dependencies** downloads all matching findings, including undisplayed rows,
as `schemaVersion: 1` JSON with `advisory: true`, report provenance, coverage,
filters, and source evidence. The read-only findings API serves removal findings,
not internal dependencies.

These warnings are advisory. Composed builds and `api:check` permit internal API
calls. `api:check` validates classifications and public-signature dependencies;
this view adds no CI enforcement.

## Notes

Click **Note** on any package, declaration/member, or usage-file node.
The inline editor accepts Markdown without dragging the node. A dot marks a node
with a note when its editor is closed. The inspector also offers an editor.
Press **⌘Enter** (**Ctrl+Enter** on Linux), click **Done**, or click outside the
editor to close it. Edits are already autosaved. **Clear** removes one note;
**Clear all** in All notes clears every note, including hidden and absent nodes.
**Undo** restores the last clear while preserving any later edits. Cleared notes
retain deletion timestamps so an older backup cannot restore them accidentally.
Existing entry-point notes remain editable and exportable in **All notes**; their
navigation button returns to the package.

Edits save immediately to browser local storage, keyed by repository identity and
stable node ID. Storage errors remain visible; use **Export JSON** to keep unsaved
notes. Browser profiles and origins have separate storage. Clearing browser storage
removes notes unless you have a backup.

**All notes** supports search, editing, navigation, and export:

- **Export Markdown** includes every nonempty note, grouped by package and node,
  with identity and source context. Hidden and absent nodes are included. Markdown
  content is preserved verbatim; the app edits it as text, without executing HTML.
- **Export JSON** produces a version 1 backup, including empty-note tombstones.
- **Import JSON** accepts backups for this repository and merges by modification
  time. Current notes win ties. Empty newer notes prevent old backups from restoring
  deleted text. Export a backup before moving notes between browser profiles.

Reindexing never deletes notes. Nodes no longer present in the snapshot are labeled
**Absent from current snapshot** and remain editable and exportable. IDs include the
package, subpath, and qualified member identity; source line changes do not change
IDs. Renaming an export or changing a subpath creates a new identity. Overloads share
one node with multiple signatures. Repository identity uses the Git remote URL, or
the checkout's absolute path when there is no remote; changing that identity changes
the notes namespace.

## Coverage and boundaries

Reports cover typed package exports. Assets and runtime-only exports without types
are reported as skipped. Signatures identify their source as **API Extractor** or
**Source compiler**. The coverage panel reports the TypeScript version used for
analysis; this index is not a repository typecheck.

Snapshots contain API metadata, source snippets, references, diagnostics, revision,
and generation time. Graph positions and browser notes are not part of reports.
See the [report contract](../../packages/dev-tools/README.md#portable-api-reports)
for generation and format details.

Coverage is static and approximate. It includes TS/JS sources and tests in core,
extensions, top-level tests, scripts, and sandbox code. Svelte scripts and templates use source-mapped analysis with generated helpers excluded.
It excludes generated output, private class members, and unexported
function graphs. Symbol aliases, re-exports, methods, overloads, and constructors
resolve to exported identities. Inherited members may share occurrence evidence.
Dynamic property names, runtime dispatch, and reflection cannot be traced reliably.
Explicit source release tags on destructured exports take precedence over Extractor's
inferred classification. Wiring evidence supplements direct symbol references;
it is not runtime tracing or a proof that each exported name has consumers.
Unresolved module imports are reported.

Errors leave partial extraction visible instead of silently claiming success. Review
the coverage panel and download the snapshot for the complete diagnostics. A zero
usage count means no matching indexed occurrence, not proof that an API is unused.

Future work: snapshot comparison and richer source navigation.
There is no authentication, shared storage, collaboration, automatic reindexing,
runtime tracing, diff UI, or application integration.

## Validate

```sh
npm run check --prefix tools/api-explorer-prototype
```

`check` runs lint, type checking, the production build, and tests. The tool has its
own dependencies and lockfile, outside the application workspaces.

For UI changes, also exercise the affected workflows in the browser and inspect
desktop and narrow layouts. Changes confined to this tool do not require the
repository's `npm run test:full`; application changes follow the root `AGENTS.md`.
