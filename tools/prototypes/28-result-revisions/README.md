# Changes since your review

An operator asked for revisions and received another plan. What changed, what disappeared, and what stayed the same?

This standalone prototype asks whether section comparison speeds repeat review without hiding consequential edits in mostly unchanged text. It compares actual retained result fixtures after a revision request. Unlike the earlier hypothetical outcome comparer, it reads two concrete documents and never predicts an outcome or invents a replacement result.

Open `index.html` directly in a browser. No installation, server, network, or account is needed. All state and notes live in memory and reset on reload.

## Explore

Choose the baseline and inspected result explicitly. The original revision request remains attached to R1 even when the baseline changes. Select a section to read deterministic added, removed, and unchanged lines. Include unchanged sections to restore context, or open both full retained texts and the whole-document line comparison.

The synthetic R2 changes the delivery-key expiry and retry limit, adds an observation window, and omits the staged rollback. These are text differences, not proof that a request was satisfied or a check was run.

Comparison notes bind to the exact pair of result records at first editing. Changing a selection or receiving another result preserves the draft. Saving against a different pair is refused until the operator returns to the original pair or explicitly rebinds it. Saved notes retain their original record IDs. Notes do not change the business turn, lifecycle, approval, or revision request.

“Simulate R3 arriving” adds a retained fixture with duplicate headings, reordered sections, and a changed generated heading ID. The inspected pair stays pinned, with a persistent notice that a newer result exists. “Inspect latest result” changes only the inspected result. Reset clears local notes and restores R1 against R2.

## Walkthroughs

1. **Review the actual edits:** inspect the removed rollback, read unchanged Scope, open both full texts, draft a remaining concern, and save it against R1 → R2.
2. **Handle uncertain headings:** inspect repeated Delivery headings as unpaired occurrences, compare the reordered Retry policy with explicit document positions, inspect the old generated heading ID as absent, and read the full text pair.
3. **Recover a missing baseline:** attempt to save with missing text, choose retained R1, observe that the old draft still cannot attach to a new pair, explicitly rebind, save, and simulate a later arrival. The two refusal steps advance only for the expected refusal reason with the original draft intact.

## Existing integration seams

- `packages/domain/src/domain-model.ts`: `ProcessTurnRecord.id` and nullable `turnResultMarkdown` identify retained execution results. `parentTurnRecordId` exists, but this experiment does not infer ancestry from sequence numbers or section positions.
- `extensions/coding/src/repository-change-process.ts`: the human plan decision offers `requestRevision`, emits `plan_revision_requested`, and routes back to plan generation. The `plan_saved` outcome advances `ProcessInstance.planRevision`. A revision counter alone does not identify the exact text an operator reviewed.
- `packages/ui/src/chronicle/components/ChronicleMarkdown.svelte`: the current rich-Markdown result renderer.
- `packages/ui/src/pages/process-detail/ProcessDetailChronicle.svelte`: the process result chronicle and its navigation to recorded results.
- `docs/operator-guide.md`: the current operator contract for reading retained results, browsing history, and taking process-defined review actions.

Production integration would need a server-owned reference from the review/request event to its exact result record, availability of both retained contents, and immutable identities or content versions for comparison notes. Durable additions require an explicit migration. A compare endpoint or pure client comparison must report missing content rather than reconstruct it. Any future submitted process action still uses existing exclusive mutation and revision checks; this page implements no such action and performs no external write.

## Comparison limits

The pure `Model` module is separate from DOM rendering. It groups exact level-two ATX headings, retaining the opening text and every source line. Repeated heading names are shown as unpaired occurrences. Renames and changed generated IDs remain separate additions/removals; they are never guessed to be the same section. Different positions are stated as document positions, not a claim that a section moved along a particular branch.

Matching is textual, not semantic inference. Nested or heading-free material stays within its enclosing text block. The small fence scanner and quadratic line comparison are sufficient for these bounded fixtures, not a full Markdown parser or a large-document diff engine. Images, linked resources, rendered Markdown semantics, live transport, authorization, and durable note storage are outside this experiment. The full exact text and line comparison are always available when both texts are retained.

The baseline selector permits any retained fixture, including the same document on both sides. Only R1 has the explicitly recorded review/request relationship. Selecting another baseline does not invent that relationship. R0 deliberately has no retained text.

## Validation

Observed in the isolated `operator-28` browser session:

- All three walkthroughs completed through real clicks (5, 4, and 6 steps). A deliberately different refusal left the missing-text walkthrough at step zero.
- Free play exercised typed drafts, empty-note and missing-text refusals, selection changes, explicit rebinding, immutable saved-note pairs, stale-result notices across section/source inspection, and the complete deterministic line comparison.
- Comparing R2 to itself showed the empty change list with Changes only and the complete context with Include unchanged.
- At 390px, reading unchanged Scope and typing a note before a new arrival preserved the expected state. Both 1440px and 390px had no horizontal overflow; visible buttons/selects measured at least 44px high. Browser error output was empty.
- `screenshots/desktop.png` and `screenshots/mobile.png` are actual 1440px and 390px captures. Both were opened and visually inspected.
- Biome check passed, all inline JavaScript passed `node --check`, and `git diff --check` passed.
- The Impeccable detector ran once on this HTML and returned no regex findings **in degraded mode**. Its HTML parser dependencies were unavailable, so computed contrast, custom properties, and selector matching were not evaluated. This is not a full detector pass.

No application tests were run: the change is confined to a standalone prototype under the repository’s scoped-validation policy. No production integration or operator usability study was performed.

## Provisional learning

A short change list draws attention to the missing rollback quickly, but it needs an immediate path back to the complete documents. Conservative unmatched headings make uncertainty visible. An explicit note binding gives operators a recoverable way to carry a draft through a new arrival without silently reviewing the wrong result. Operator usability and review-speed improvement remain unmeasured.
