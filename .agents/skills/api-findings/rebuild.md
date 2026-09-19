# Rebuild local evidence

## Local settings

Store personal configuration at `$CORE/.leitwerk/api-explorer/local.json`, outside
the reports directory. The report loader treats every JSON child of its directory
as report evidence; a settings file there would cause incomplete-loading diagnostics.

```json
{
  "version": 1,
  "baseUrl": "http://127.0.0.1:4318",
  "reportDirectory": ".leitwerk/api-explorer/reports",
  "catalog": { "workspace": ".", "composition": null },
  "consumers": [
    {
      "workspace": "../example-extension-workspace",
      "composition": ".leitwerk/development.composition.yaml",
      "expectedCore": ".leitwerk-base"
    }
  ]
}
```

Resolve workspace and report-directory paths from `CORE`; resolve composition and
expected-core paths from their owning workspace. Absolute paths also work.
`composition: null` means no explicit report composition. `expectedCore: null`
means installed-release mode; a path means that specific local checkout is expected.
For release-mode consumers, select their committed composition when appropriate,
not an old generated local-mode manifest. Keep only confirmed workspaces in this
file; sibling names and nested core locations are machine-specific.

## Rebuild sequence

1. **Preflight every workspace.** Read its `AGENTS.md` and package scripts. Run
   `npm --prefix "$WORKSPACE" run core:status` for each consumer and compare the
   selected checkout with `expectedCore` using canonical paths. Verify that the
   report composition belongs to that workspace and agrees with the selection.
   Inspect the catalog's composition too, when configured. A consumer may use its
   own nested checkout rather than `CORE`; preserve that choice. If scripts,
   dependencies, generated manifests, or selection are missing/stale, report the
   required repair and obtain approval before installation or `core:use-local` /
   `core:use-release`. These commands can reinstall dependencies and rewrite links.
   **Done:** every configured workspace has a usable, confirmed build/report plan.

2. **Build sequentially.** In the catalog workspace, run `npm run build`; for an
   explicit catalog composition, set `LEITWERK_COMPOSITION_PATH` to its absolute
   path. Otherwise clear that inherited variable. In each consumer, run its own
   `npm run build` wrapper with inherited composition overrides cleared; its
   selected mode supplies the composed build. If an explicit build override is
   needed, verify the wrapper's supported options first. Sequential execution
   avoids racing shared core outputs. Capture each exit status and log under
   `$CORE/.leitwerk/api-explorer/`, outside `reports/`. Stop at a failed build;
   existing reports then remain old evidence, not a refreshed collection.
   **Done:** the catalog and every consumer build succeeded, or failures and all
   not-yet-built workspaces have been reported. Proceed only on full success.

3. **Generate one catalog, then consumer usage reports.** Read the existing
   [report CLI contract](../../../packages/dev-tools/README.md#portable-api-reports)
   and run `npm --prefix "$CORE" run api:report -- --help` if flags have changed.
   Clear inherited `LEITWERK_COMPOSITION_PATH` for these invocations; pass each
   configured composition explicitly as an absolute `--composition` argument.

   ```sh
   # CATALOG is the absolute catalog workspace; REPORTS is the absolute destination.
   env -u LEITWERK_COMPOSITION_PATH npm --prefix "$CORE" run api:report -- \
     --workspace "$CATALOG" --built --output-dir "$REPORTS"

   # Repeat for every configured consumer; WORKSPACE is absolute.
   env -u LEITWERK_COMPOSITION_PATH npm --prefix "$CORE" run api:report -- \
     --workspace "$WORKSPACE" --usage-only --output-dir "$REPORTS" \
     --composition "$COMPOSITION"
   ```

   Add `--composition` to the catalog command when configured; omit it from any
   command whose configuration is null. `--built` requires the successful preceding
   build. `--usage-only` never builds: it reads the consumer's selected dependency
   graph. Main-checkout tooling does not relink that graph. Consumer generation
   must use `--usage-only` so it cannot overwrite `catalog.json`.
   **Done:** each invocation succeeded and emitted the expected catalog or
   `usage-<source-id>.json`; record source IDs and report timestamps for all inputs.

4. **Verify the collection.** Connect to the explorer using
   [SKILL.md step 2](SKILL.md#2-connect-to-the-findings-api), then query the findings
   summary and match every expected
   source ID, revision, and fingerprint to the files just written. Account for
   unexpected old consumer reports; offer to move them to an ignored archive
   outside `reports/` rather than deleting evidence silently. Retain intentional
   supplemental runtime evidence. Build success, successful extraction of every
   entry point, and report freshness do not imply complete static coverage.
   Different selected core versions can contribute positive usage while blocking
   absence-based conclusions. Report compatibility gaps and diagnostics rather
   than switching consumers merely to make them disappear.
   **Done:** every configured source is represented by its new report, no
   unexpected source is silently included, and coverage limitations are stated.

For selection/manifest semantics beyond the CLI help, read the
[development-tools guide](../../../packages/dev-tools/README.md#local-core).
