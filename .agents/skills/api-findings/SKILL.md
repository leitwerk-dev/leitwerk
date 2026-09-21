---
name: api-findings
description: API findings — use when refreshing API reports across local development compositions or reviewing export-removal candidates through the read-only explorer API.
---

# API findings

## 1. Select evidence

Locate the Leitwerk checkout containing `tools/api-explorer-prototype/`; call its
absolute path `CORE`. Read `$CORE/.leitwerk/api-explorer/local.json`. Paths and
consumer lists belong in that ignored file, not this skill or shared application
configuration. Confirm it is ignored with `git -C "$CORE" check-ignore` before
writing personal settings.

If the file is absent, ask which workspaces to include and create it using the
format in [rebuild.md](rebuild.md#local-settings). An empty consumer list is valid;
a missing configured workspace is a blocker, not permission to silently drop it.

Choose the branch from the request:

- **Inspect existing evidence:** use the running API; report its source revisions
  and coverage. Existing reports need not represent current source files.
- **Refresh/rebuild evidence:** follow [rebuild.md](rebuild.md) before querying.
  Building is explicit; an inspection request alone does not authorize dependency
  installation, mode switching, or starting the application.

Done when the configured catalog, consumers, report directory, and requested
freshness are known; every missing input has been resolved or reported.

## 2. Connect to the findings API

Use `baseUrl` from local settings. Fetch `/api/v1/schema` to discover current enum
values and response contracts. If unavailable, start only the standalone explorer:

```sh
npm run dev --prefix "$CORE/tools/api-explorer-prototype" -- --reports-dir "$REPORTS"
```

`REPORTS` is the absolute configured report directory. The server defaults to
`http://127.0.0.1:4318`; check the startup URL against `baseUrl`. Reuse an existing
server only after its summary identifies the expected catalog and consumer set.
A port conflict is a reason to inspect the listener, not terminate another process.

Done when the schema responds and summary report identities match the requested
collection. The explorer reads reports; it does not build or discover consumers.

## 3. Review through the API

Use HTTP rather than browser automation. `BASE` below is the configured base URL.

| GET path | Use |
| --- | --- |
| `/api/v1/findings/summary` | Coverage, source revisions, and classification counts |
| `/api/v1/findings` | Filtered list; `limit` and opaque `cursor` paginate |
| `/api/v1/findings/detail?id=…` | Full evidence, retaining APIs, and route migrations |
| `/api/v1/findings/export` | All matching findings and normalized occurrence evidence |
| `/api/v1/schema` | Filters, codes, fields, versions, and errors |

```sh
curl -fsS "$BASE/api/v1/findings/summary"
curl -fsSG "$BASE/api/v1/findings" \
  --data-urlencode 'change=reduce-package-exposure' \
  --data-urlencode 'assessment=review-required' \
  --data-urlencode 'limit=50'
curl -fsSG "$BASE/api/v1/findings/detail" \
  --data-urlencode "id=$FINDING_ID" \
  --data-urlencode "analysisId=$ANALYSIS_ID"
```

List/summary/export combine `query`, `package`, `change`, `assessment`, `constraint`,
and `scope` with AND. Pin the summary's `analysisId` for the review; keep filters
unchanged while following `nextCursor` until null. A 409 means evidence or filters
changed: restart that review rather than mixing pages. Export uses version 2;
list/detail/summary use schema version 1. Discover exact contracts from the schema
instead of inferring them from display prose.

Read `proposedChange`, `assessment`, action-scoped `constraints`, and each route's
assessment together. Test-only observations are usage evidence, not deletion
permission. Retaining a declaration need not retain every barrel route. Incomplete
coverage blocks absence-based endorsements; positive consumers still retain their
routes. Report migration prerequisites and compatibility/runtime blockers explicitly.

Done when every finding in the requested scope has an evidence-backed disposition,
or is listed as unresolved. Include the analysis ID and coverage caveat. Deliver
recommendations in chat or a user-requested artifact; browser-note writes and source
changes require a separate explicit request.
