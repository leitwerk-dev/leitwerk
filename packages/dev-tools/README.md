# Development tools

`@leitwerk-dev/dev-tools` provides the `leitwerk-dev` CLI for an extension workspace.
Install it alongside matching `@leitwerk-dev/server`, `@leitwerk-dev/ui` and SDK
versions. Node 26, npm and POSIX are required. Git is needed only for source mode.

```json
{
  "scripts": {
    "dev": "leitwerk-dev dev",
    "build": "leitwerk-dev build",
    "typecheck": "leitwerk-dev typecheck",
    "test:full": "leitwerk-dev test:full",
    "core:status": "leitwerk-dev core:status",
    "core:use-local": "leitwerk-dev core:use-local",
    "core:use-release": "leitwerk-dev core:use-release"
  }
}
```

Commands use the current directory. `--workspace PATH` selects another workspace;
`--composition PATH` selects its manifest, relative to that workspace. Use a
version 1 `leitwerk.composition.yaml` with `runtime_config`, `extensions` and
optional `test_roots`. Extension paths resolve relative to the manifest; package
names resolve through its npm installation. Declare only your own packages in
the workspace's `package.json`. Literal workspace paths, trailing `/*` patterns
and the `{ "packages": [...] }` workspace form are supported.

## Installed packages

`leitwerk-dev api:check --workspace PATH` checks the workspace's typed package
exports. Every exposed declaration and member needs `@public` or `@internal`.
The check rejects conflicting tags and internal supporting types in public
signatures. It permits calls to internal APIs. Source exports take precedence;
declaration exports work for packages without a source condition. The command
does not select or clone a core checkout.

Breaking public APIs require release notes and a minor bump during `0.x`, or a
major bump from `1.0`. Members retain individual classifications.

Add `--built` after building to verify the emitted exports and release tags.
The core build restores explicit member tags that TypeScript drops when
expanding inferred or mapped structures; it never enables `stripInternal`.

The default mode uses installed packages and requires no core checkout.
`build` orders workspace packages by dependency and runs their `build` and
`build:ext-ui` scripts. `typecheck` runs the installed TypeScript project build.
`test:full` runs the workspace's installed Biome, builds, type checks, Vitest and,
when a Playwright configuration exists, Playwright. Install the corresponding
test tools in the workspace; commands never download missing tools through npx.

`dev` builds the extensions, starts the installed server and serves the installed
UI with API, extension UI and WebSocket forwarding. Source, package metadata,
runtime configuration and composition changes rebuild and restart the backend.
Failed builds or invalid configuration leave the running backend available.
Successful configuration edits reread ports and proxy targets. `HOST`, `PORT`,
`LEITWERK_UI_PORT`, `LEITWERK_CONFIG_PATH` and `LEITWERK_BASE_URL` override the
corresponding settings. The UI listens on loopback with strict port selection.
This runner uses your configured application storage and credentials; isolated
scripted scenarios belong to the separate development sandbox.

Repository-specific checks can use two optional npm scripts:

- `leitwerk:before-test` runs after Biome and before full validation in either mode.
- `leitwerk:after-typecheck` runs after successful `typecheck` or `test:full` in
  either mode, for auxiliary TypeScript projects outside the composed packages.

`sandbox` starts a sandbox composition declared in the manifest's `sandboxes` map.
It requires the local core, because the supervisor and UI tooling are
source-only. `--sandbox=NAME` selects one of several entries. `--llm=real`, the
port options and `reset` pass through to the checkout's sandbox launcher. See the
[harness contract](../dev-sandbox/README.md).

## Local core

```sh
leitwerk-dev core:use-local --revision <commit-or-tag>
leitwerk-dev core:status
leitwerk-dev dev
leitwerk-dev core:use-release
```

On first use, the CLI clones the public repository to `.leitwerk-base` and checks
out the explicit revision on a `development` branch. A `public_git_sha` in the
workspace's `leitwerk-base.lock.yaml` supplies the revision when omitted.
`--checkout PATH` and `--repository URL` select a different checkout and clone
source. Existing checkouts retain their branch, commits and edits; the initial
revision and repository arguments do not retarget an existing checkout.

Selection installs both locked dependency graphs, links every public workspace
package consistently, builds core, and writes ignored selection/composition files
under `.leitwerk`. Manifests and npm lockfiles remain unchanged. The selected
checkout runs `dev`, `build`, `typecheck` and its full composed test gate. Changing
either lockfile or replacing links with a manual npm install requires rerunning
`core:use-local`.

`core:use-release` restores the workspace's locked installation and keeps the
checkout, branches and edits. Existing private-runner selection files remain
readable. Interrupted switches block ordinary commands until a switch succeeds.
Normal commands never clone, fetch, switch branches, or select local mode merely
because a checkout exists.

The package root exports `runDevelopment(command, options)` for repository
wrappers. `/composition` and `/workspace` share manifest parsing and package
discovery with the public source-development commands. Both return package metadata
at the top level alongside the canonical `dir`; composed packages have no nested
`packageJson` wrapper. The sandbox CLI still
requires the source supervisor; this package does not provide installed-package
sandbox startup.

## Worker startup benchmark

`leitwerk-dev benchmark:worker-startup` measures sequential launches through the
ordinary launcher interface. It needs a reachable Leitwerk API and an available
model profile. It can run outside a Git checkout and does not require Kubernetes.

Create a client YAML file with `base_url` and `api_token`, and a JSON file containing
the selected launcher's input. The client file is kept at mode `0600`; its token
is used only for API requests and is excluded from reports.

```sh
leitwerk-dev benchmark:worker-startup \
  --api-config .leitwerk/api/leitwerk.yaml \
  --launcher poem_creator_process.poem_creator_ui \
  --model-profile example-model \
  --input benchmark-input.json \
  --title 'Startup sample' \
  --candidate candidate-a \
  --output .leitwerk/benchmarks/candidate-a
```

The launcher and model profile are explicit. Choose a process that completes
without human input and includes the model work you want to measure. The input
file contains the `launcherInput` object, for example
`{ "prompt": "Write a short poem about rain." }`.
Defaults are 30 measured launches, no warm-ups, a 180-second per-launch deadline,
and 500-ms polling. `--samples`, `--warmups`, `--timeout-ms` and
`--poll-interval-ms` override these values. `--help` lists all options.

The output directory must be new. It contains `inputs.json`, the pre-request
`launches.jsonl` journal, complete `results.jsonl` samples and `report.md`, with
directory mode `0700` and file mode `0600`. Each launch has its own idempotency
key. Lost launch responses retry that same key. A timeout, interruption or
uncertain API outcome stops the run before another generation starts. The
benchmark retains processes, sessions and evidence. Resolve the retained launch
before starting a new run after an uncertain result. A successful turn inside an
active process does not start the next sample; the benchmark waits for the whole
process to complete. A failed turn in an active process stops the run for
diagnosis. Aborted processes and launch failures before process creation are
recorded and permit the next sample. Incomplete runs and runs with failures exit
nonzero.

Reports show median, nearest-rank p90, maximum, and available timing coverage,
with separate cached, pulled and unknown image groups. Warm-ups are excluded from
measured statistics. Missing and invalid durations are excluded and counted in
coverage. Rows describe the first physical worker; raw samples retain replacements.
Kubernetes intervals may overlap. Launch-to-first-text includes model latency;
compare candidates with the same launcher input and model profile.

For optional read-only Kubernetes evidence, select the Deployment serving the
configured API:

```sh
# Append to the benchmark command:
--namespace example --deployment example-server --kubeconfig /path/to/config \
--expected-server-image registry.example/server@sha256:<digest>
```

The CLI records Deployment images, Leitwerk provenance annotations and selected
Pod image IDs. `--expected-server-image` optionally requires an exact image
reference in the Deployment. No local public/private Git layout is assumed.
The `/benchmark` export provides `runWorkerStartupBenchmark`, report functions
and their types for repository wrappers.

## Portable API reports

`leitwerk-dev api:report` generates JSON evidence without installing or starting the
API explorer. In a Leitwerk checkout, use `npm run api:report`.

| Option | Contract |
| --- | --- |
| `--workspace PATH` | Analyze this workspace; defaults to the current directory. |
| `--composition PATH` | Include explicitly declared packages and test roots using composition discovery. Relative paths resolve from the analyzed workspace. |
| `--usage-only` | Read source and installed package metadata without building. Write consumer evidence without replacing the catalog. |
| `--output-dir PATH` | Report destination; defaults to `.leitwerk/api-explorer/reports/` under the analyzed workspace. Explicit relative paths resolve from the invocation directory. |
| `--built` | Reuse a successful preceding build. Catalog generation otherwise builds using the selected development mode. |

```sh
npm run api:report -- --composition /path/to/leitwerk.composition.yaml
npm --prefix /path/to/leitwerk run api:report -- \
  --workspace /path/to/consumer --usage-only --output-dir /path/to/report-collection
```

An installed consumer can define `"api:report": "leitwerk-dev api:report --usage-only"`.
It needs no core checkout. Invoking a checkout with `npm --prefix` does not change
the consumer's dependency selection. Generation is explicit, never part of every build. Source discovery does not descend
into nested Git checkouts or worktrees. Select their packages or test roots explicitly
through a composition when they belong to the analysis.

The version 1 envelope contains `schemaVersion`, `producerVersion`, `kind`, `source`
(identity, revision, content fingerprint), `analyzedPackages`, and `snapshot`.
`catalog.json` contains exported declarations, export routes, canonical implementation
identities, signatures, snippets, local occurrences, wiring, relationships, diagnostics,
and coverage. `usage-<source-id>.json` carries the same evidence from a consumer.
Files replace the previous report for that source atomically. Locations and snippets
are embedded and relative to the analyzed workspace; readers never open those locations.
Copy reports into a collection directory. Do not collect old revisions as new consumers.

Each occurrence may include `sourceOrigin: "workspace" | "composition"`. Workspace
sources and declared consumer test roots are `workspace`; explicit packages from a
declared core checkout or another composed package root are `composition`. The most
specific root wins, so copied core packages nested below a consumer workspace keep
their composition ownership. The field is additive in schema version 1. Readers must
accept older reports without it and treat their origin as unknown.

Targets use stable package, subpath, and qualified export/member IDs. Aliases retain
separate routes and share canonical implementation evidence. Members declared only
in TypeScript's standard library are not indexed beneath aliases or derived APIs:
calling a string's `replace()` is not evidence of using a package's string alias.
Declared API members and inherited non-standard-library members remain indexed. Different package versions
can supply matched positive evidence, but cannot establish an absence of consumers.
Unmatched symbols and incompatible schemas remain diagnostics. Empty evidence never
proves that a declaration can be removed. Coverage describes the loaded sources.

Supplemental JSON uses the same version 1 envelope, `kind: "supplemental"`, a distinct
`source.id`, and a valid snapshot (which may have empty arrays and zero source files).
Add `keep: [{ "target": "<stable API ID>", "reason": "Loaded by name at runtime" }]`
to preserve an export for runtime use or another explicit reason. Copy the target ID
from exported findings. Keep reasons override removal proposals. Supplemental
occurrences use the catalog's target IDs and carry their own source snippets.
