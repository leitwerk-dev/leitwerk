# Redacted support bundle prototype

Operators investigating a failed turn need to share useful evidence without copying complete process content or hidden credentials into a support ticket. This throwaway experiment asks whether section selection, a field-by-field explanation, and an explicit review gate make that tradeoff understandable.

Open `index.html` directly in a browser. No server, dependencies, or application setup is required. Everything is synthetic and held in memory. The only output is a JSON download initiated by the user. Nothing is uploaded.

## Behavior

Choose process lineage, execution evidence, runtime diagnostics, and personal content independently. The preview compares each raw fixture with its exported value and explains the transformation. Hide raw values to review only the outgoing content.

Known fixture credentials are removed. Personal attribution and repository locations become aliases. Process and execution identifiers use stable aliases within the bundle, so a support reader can follow their relationship. A missing historical instruction stays `not_recorded`; current configuration never fills that gap. The manifest lists included sections, transformed fields, omissions, and policy limitations without including the raw alias map.

Confirm the current preview before downloading. Any selection, note, or field decision invalidates that confirmation. Empty bundles are blocked. An added free-text field always blocks export until the operator redacts the entire field or excludes it; a review click cannot override this gate.

The pure `initialState`, `sanitize`, `inspect`, `bundle`, and `reduce` functions are separate from the DOM and download shell. This is a fixture policy, not a general sanitizer.

## Walkthroughs

- **Default redaction:** compare raw and exported credentials and repeated process references. Review and download. The payload retains diagnostic codes, timing, and correlation but excludes all fixture secrets.
- **Leave personal content out:** start the scenario, exclude that section, review, and download. The manifest explains the omission and the payload contains no personal section.
- **Unfamiliar secret:** add the scenario note, attempt download, redact the whole field, review, and download. The initial attempt is blocked; the downloaded note is a removal marker.

Free play also supports entering a custom synthetic note, excluding that note, changing section selection after review, hiding raw fixtures, and resetting the experiment. Changing scenario resets to known initial state. Guided steps use the same reducer as free-play controls.

## Integration seams if the idea graduates

- `packages/server/src/routes/process-diagnostics-assembler.ts`: `ProcessDiagnosticsAssembler.assembleDetail` already captures durable diagnostic facts before session I/O. A future export should define its capture boundary explicitly, preserving that distinction.
- `packages/server/src/process-inspection-reader.ts`: `ProcessInspectionReader` exposes compact summaries and on-demand context, configuration, and trace evidence. An export should consume authorized recorded evidence, preserving `not_recorded`, `redacted`, and `not_applicable` states.
- `packages/server/src/process-inspection-trace.ts`: the trace projection retains explicit redaction markers. These are evidence, not missing fields to reconstruct.
- `packages/ui/src/pages/process-detail/inspector/ProcessInspector.svelte`: a future support action could originate from the current inspector context and selected execution.
- `docs/security.md`, “Execution inspection evidence”: workers capture specified model-facing evidence, never arbitrary environment variables or credential files; known delivered secrets are redacted before inspection IPC. This export proposal would add another deliberate disclosure boundary after that capture. Existing raw tool output can still contain sensitive content.

No production routes, configuration, runtime paths, dependencies, or cross-cutting contracts are changed.

## Validation

- Biome checked and formatted the standalone HTML. Extracted inline JavaScript passed `node --check`; `git diff --check` passed.
- Real Chromium session `idea-15` exercised review-before-download, all three guided scenarios, custom note exclusion, empty-selection blocking, and review invalidation after section changes. Keyboard activation was used for reliable long-page interactions. Browser error collection was empty.
- Actual default, personal-section-omitted, and whole-note-redacted JSON files were downloaded through the browser and parsed. All lacked `FAKE_` fixture secrets, raw personal email, repository location, and raw process ID. Repeated process aliases matched, and missing historical evidence remained `not_recorded`.
- The default downloaded artifact is retained as `example-export.json` for review. It is the browser output, reformatted with Biome, not a separately authored example.
- Desktop (1440px) and mobile (390px) screenshots were captured and opened. Both layouts stayed within the viewport.
- The optional Impeccable detector ran in its degraded regex mode with no findings; unavailable parser modules mean this is not a computed contrast or accessibility audit.

As an isolated standalone helper, this uses scoped syntax and browser checks under `AGENTS.md` section 7. Application `test:full` was not run.

## Provisional learning and limits

The useful unit of approval is the exact current preview. Tying review to that state makes changes and omissions visible, while aliases preserve correlation without exporting raw identifiers. An unfamiliar free-text field needs its own decision; a reassuring automatic-redaction count is insufficient.

These observations come from fixture walkthroughs, not operator usability research. The sanitizer recognizes only the fixed schema and hand-authored fixture text on this page. It does not detect arbitrary, encoded, fragmented, or previously unknown secrets; whole-field removal is the only custom rule. Alias values are stable within this fixture and are not a cross-bundle identity or anonymity guarantee. A production design needs a policy for evidence selection, schema coverage, capture consistency, size limits, and manual review. No automatic collection, live credential access, actual server export, or upload is implemented.
