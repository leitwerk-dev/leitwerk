# Skill packs

An extension can install adapted skills into the selectable skill catalog. A skill
pack contains generated skill directories and a manifest. The server imports them
from the installed package at startup. Workers receive only the immutable revisions
attached to their process, including declared dependencies.

This is separate from `leitwerk.pi.resources.skills`, which contributes skills to
every worker snapshot. Use a skill pack for operator-selectable skills.

## Package contribution

Declare the generated manifest in `package.json` alongside the extension entry:

```json
{
  "leitwerk": {
    "extension": {
      "source": "./src/index.ts",
      "import": "./dist/index.js"
    },
    "skills": "./dist/skills/manifest.json"
  }
}
```

The manifest path must remain inside the package. Source and built runtime lanes
use the same generated resources. Build the package before starting either lane;
include the generated resources in its npm `files` list. Startup does not fetch
upstream repositories or execute adaptation patches.

The version 1 manifest implements `SkillPackManifest` from
`@leitwerk-dev/protocol`. It contains `formatVersion: 1`, `upstream.url`, the exact
`upstream.commit`, a SHA-256 `patchDigest`, and `skills`. Each skill declares `id`,
`directory` relative to the manifest, `label`, `description`, its upstream
`sourcePath`, and `dependencies` as skill IDs.

IDs contain lowercase letters, digits, and hyphens, start with a letter or digit,
and have at most 63 characters. Namespace IDs by source. All dependencies must be
in the same pack, with no cycles. Every skill directory contains a root `SKILL.md`
whose frontmatter name and description match the manifest. Resources are regular
files; symlinks and paths escaping the package are rejected.

## Maintain adaptations

The `@leitwerk-dev/dev-tools` commands use a package-local `skill-pack.json` recipe:

```json
{
  "upstream": {
    "url": "https://example.org/skills.git",
    "commit": "0123456789abcdef0123456789abcdef01234567"
  },
  "licenses": ["LICENSE"],
  "skills": [
    {
      "id": "example-review",
      "sourcePath": "skills/review",
      "dependencies": []
    }
  ]
}
```

Commit the selected pristine files under `upstream/`, the recipe, and the unified
diff at `patches/leitwerk.patch`. An empty patch is valid. Generated `dist/skills/`
and the editable `.skill-pack/work/` directory are build and maintenance artifacts.
Ignore them in Git.

```sh
leitwerk-dev skills:prepare --package ./extensions/example-skills
# Edit .skill-pack/work/ inside that package.
leitwerk-dev skills:diff --package ./extensions/example-skills
leitwerk-dev skills:build --package ./extensions/example-skills
```

`prepare` applies the existing diff to a clean snapshot and refuses to overwrite an
existing working copy. `diff` records additions, edits, and deletions against the
pristine snapshot. `build` applies the committed diff, validates frontmatter,
declared dependencies, local Markdown resource links outside fenced examples, and
bundle path lengths, then replaces the generated output. It copies upstream
licenses into each skill so attribution survives independent attachment.

For an upstream update, first preserve or finish edits in the existing working
copy, then remove that maintenance directory and run:

```sh
leitwerk-dev skills:prepare --package ./extensions/example-skills --ref <commit-or-tag>
```

Only explicit `--ref` fetches upstream. It replaces the vendored selection and
records the resolved commit. If the old patch fails, the command exits with the
file and hunk diagnostics and leaves a pristine working copy for resolving the
adaptation. Existing generated output stays intact. Review the new diff and build
before publishing. Ordinary builds are offline and reproducible.

Build scripts can call `buildSkillPack(packageDirectory)` from
`@leitwerk-dev/dev-tools/skill-pack`, for example from a tsup `onSuccess` hook.
When watching, include the recipe, upstream files, and patch as build inputs.

Adapt every instruction-bearing resource, including descriptions and templates.
Use the target turn's workspace tools, question capability, and result-publication
contract. Skill text does not grant tools or define process transitions.

## Revision ownership

Loading an extension activates its complete pack in one startup transaction.
Malformed packs or conflicting owners reject startup. Repository-catalog actions
cannot replace or remove extension-owned IDs, including after the owner is unloaded.
The Skills page identifies the owning extension and displays the adapted instructions
and revision provenance.

Launch selection pins the selected skill and its explicit dependency revisions.
Package upgrades change the active revisions for future launches. Removing a pack
or skill deactivates it for future selection. Existing processes and their pinned
dependencies retain their stored bundles across worker restarts and extension
removal. Reinstalling the same pack reuses identical revisions.

Provenance records the owning extension, package and version, upstream URL and
commit, source path, adaptation digest, and declared dependencies. Provenance is
included in revision identity: changing dependencies creates a new revision even
when the skill's prose is unchanged.
