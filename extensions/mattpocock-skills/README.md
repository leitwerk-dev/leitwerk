# Matt Pocock skills for leitwerk

This extension packages four skills from
[mattpocock/skills](https://github.com/mattpocock/skills): architecture improvement,
codebase design, grilling, and domain modeling. `skill-pack.json` pins the upstream
commit and declares their IDs and dependencies. The pristine selection lives in
`upstream/`; `patches/leitwerk.patch` records all instruction changes.

## Use

Build and install `@leitwerk-dev/mattpocock-skills`, then add it to
`extension_loading.sources`. Restart the server to import the pack. Select
`mattpocock-improve-codebase-architecture` when launching a process and ask for an
architecture review. Its design, grilling, and domain-modeling dependencies are
attached automatically. Each skill can also be selected individually.

The adapted skills are discoverable by the model after launch selection. The
architecture skill's upstream explicit-command-only flag is removed because
leitwerk selects skills at launch rather than exposing the upstream command UI.
The turn needs repository-reading tools for exploration. Interactive rounds use
`ask_questions` when enabled; otherwise the result records outstanding decisions.
Publication follows the turn's existing result and outcome contract.

## Adaptations

The architecture report uses Markdown and fenced Mermaid before/after diagrams.
Its description and template use that format throughout. Supporting skills read
attached dependencies through `read`, explore alternative designs sequentially,
and respect the target repository's glossary and ADR conventions. Changes to
repository documents remain within the active task's scope and tools.

The pack defines instructions only. Loading it installs selectable catalog entries;
it does not create a process or attach skills to every worker.

## Update

From the repository root, after building the dev tools:

```sh
npm run skills:prepare -w @leitwerk-dev/mattpocock-skills
# Edit extensions/mattpocock-skills/.skill-pack/work/.
npm run skills:diff -w @leitwerk-dev/mattpocock-skills
npm run build -w @leitwerk-dev/mattpocock-skills
```

Review and commit the patch. Source and built runtime lanes both consume
`dist/skills/manifest.json`. Finish with the repository's full validation.

To update upstream, finish or preserve the current working copy and remove
`.skill-pack/work/`, then run `skills:prepare` with `-- --ref <commit-or-tag>`.
Resolve any patch failures in the new working copy and regenerate the diff before
building. Commit the updated pristine files, pinned recipe, and patch together.
See [Skill packs](../../docs/skill-packs.md) for the contribution and maintenance
contracts.

The upstream files are MIT licensed. Their original license is retained under
`upstream/LICENSE` and copied into each generated skill bundle. The extension code
uses the repository's Apache-2.0 license.
