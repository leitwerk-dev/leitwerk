# Skill packs

An extension can ship adapted, operator-selectable skills as a **skill pack**: generated skill directories plus a manifest imported by the server at startup. Workers receive only the immutable revisions pinned to their process, including declared dependencies.

Skill packs are distinct from `leitwerk.pi.resources.skills`, which bundles skills into every worker snapshot automatically. Use a skill pack when operators or process defaults should opt into skills individually.

## Package declaration

Declare `leitwerk.skills` alongside `leitwerk.extension` in `package.json`:

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

- The manifest path must stay inside the package. Both source and production lanes load the generated output; build the package before starting either lane and include `dist/skills` in `files`.
- Startup never fetches upstream repositories or applies patches.
- The version 1 manifest (`SkillPackManifest` in `@leitwerk-dev/protocol`) declares `formatVersion: 1`, `upstream.url`, exact `upstream.commit`, SHA-256 `patchDigest`, and `skills[]` (`id`, `directory`, `label`, `description`, `sourcePath`, `dependencies`).
- Skill IDs match `^[a-z0-9][a-z0-9-]{0,62}$` and should be namespaced by source. Dependencies must stay within the same pack with no cycles. Every skill directory must contain a root `SKILL.md` whose frontmatter `name` and `description` match the manifest. Only regular files inside the package are allowed (no symlinks or path escapes).

## Authoring and updating adaptations

Create a package-local `skill-pack.json` recipe:

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

Commit `skill-pack.json`, the pristine selected files under `upstream/`, and the unified diff at `patches/leitwerk.patch` (an empty patch is valid). Gitignore generated `dist/skills/` and the editable `.skill-pack/work/` directory.

Use `@leitwerk-dev/dev-tools` to maintain adaptations:

```sh
leitwerk-dev skills:prepare --package ./extensions/example-skills
# Edit files under .skill-pack/work/
leitwerk-dev skills:diff --package ./extensions/example-skills
leitwerk-dev skills:build --package ./extensions/example-skills
```

- `skills:prepare` applies `patches/leitwerk.patch` into a clean working copy and refuses to overwrite an existing one.
- `skills:diff` regenerates `patches/leitwerk.patch` against `upstream/`.
- `skills:build` applies the committed patch offline, validates frontmatter, dependencies, relative Markdown links outside code fences, and path lengths, copies upstream license files into each skill, and writes `dist/skills/`.
- Build scripts can invoke `buildSkillPack(packageDirectory)` from `@leitwerk-dev/dev-tools/skill-pack` (for example from a `tsup` `onSuccess` hook).

To update to a new upstream commit or tag, finish or discard edits in `.skill-pack/work/`, remove that directory, and fetch explicitly:

```sh
leitwerk-dev skills:prepare --package ./extensions/example-skills --ref <commit-or-tag>
```

Only `--ref` contacts upstream. If the existing patch fails to apply, the command reports hunk diagnostics and leaves a pristine working copy while keeping previous generated output intact.

Adapt all instruction-bearing files (including descriptions and templates) to the target turn's tools, `ask_questions`, and result publication contracts. Skill prose never grants tools or defines process transitions.

## Ownership and revision pinning

- Startup activates a pack atomically; malformed packs or conflicting skill IDs fail startup.
- Repository-catalog UI actions cannot overwrite or delete extension-owned skill IDs, even after unloading the extension.
- Launches pin the selected skill and its dependency revisions. Upgrading a pack updates future launches; existing processes retain their pinned bundles across restarts and extension removal.
- Provenance (owning extension, package version, upstream URL/commit, source path, patch digest, and dependencies) is part of revision identity: changing dependencies produces a new revision even when prose is unchanged.

See [mattpocock-skills](../../extensions/mattpocock-skills/README.md) for a working built-in example.
