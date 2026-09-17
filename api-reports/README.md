# API classification reports

`*.api.md` records package exports, the original declaration behind each
re-export, individual release tags, and signatures. `npm run api:check` rejects
drift. Review changes before running `npm run api:check -- --update`.

The core build preserves comments and copies explicit source member tags into
declaration structures expanded by TypeScript (including mapped and spread
types). It does not inherit a container's tag. `api:check --built` checks that
exports and source classifications survive emission. Compiler-synthesized
structure from third-party types is governed by those types' owning package.

`initial-usage.json` records the initial consumer evidence and named supporting
types. Paths are relative to the named consumer, with source line numbers at
capture time. Each consumer's Git revision and uncommitted file list are
included. The capture contains 297 source files, including development scripts
in hidden directories, plus one executable program embedded in a script.
Generated bundles and alternate or vendored core checkouts are excluded.
The report includes static, dynamic, type-only, member, callback,
inheritance, supplied-contract, and composition usage.

Member evidence requires a dependency path to a Leitwerk package. This avoids
attributing an unrelated JavaScript object's structurally identical fields to
an SDK declaration. Contracts supplied through variables count as usage;
forwarding existing SDK objects does not promote every member.

Forwarding a typed object with spread syntax does not promote all its members.
A locally supplied property does. Private implementations are resolved by
package identity; matching upstream method names do not establish usage.
Loading an extension in a composition supports its default entry point only.
Documentation, dependency declarations, generated output, dependencies, and
vendored core checkouts do not establish usage. The UI package ships assets
and has no typed package entry point.

The optional evidence capture command reads consumer sources without executing
them. It is not part of CI:

```sh
node --import tsx scripts/capture-api-usage.ts \
  --consumer ../leitwerk-private \
  --consumer ../leitwerk-public \
  --consumer ../leitwerk-rsnc \
  --output /tmp/current-api-usage.json
```

`--annotate` bootstraps an unclassified surface and refuses to overwrite an
existing evidence file. It never changes existing tags. Future classification
changes require review. A public API keeps its compatibility promise when usage
disappears: release notes and a minor bump in `0.x`, or a major bump from `1.0`,
are required to break it or withdraw support.

## Unresolved consumer dependencies

The capture records unresolved references as diagnostics. They are not evidence
of unused APIs. Some diagnostics are JavaScript inference limitations or
pre-existing consumer type errors; they remain visible for review.

RSNC's `leitwerk-source.lock.json` selects commit
`81a3877deb37e4658a853ca7829a97ab4dd76f89`. Its installed
`@leitwerk-dev/gitlab` is a symlink to `.leitwerk-base/extensions/gitlab` at that
revision **with uncommitted changes**. Those changes in `src/client.ts`,
`src/external.ts`, `src/tools.ts`, and `src/testing.ts` provide the feedback,
seen-reaction, merge-status, and test-adapter APIs missing here. In particular,
`pendingGitLabFeedback`, `ensureGitLabSeenReaction`,
`GitLabClientLike.listMergeRequestFeedback`, merge-status fields, feedback state,
and response-loss test helpers cannot be classified in this checkout. Restoring
those APIs is separate work. This baseline records their consumers rather than
promoting a similarly named declaration or treating the missing APIs as unused.
