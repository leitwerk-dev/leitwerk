# Process workspace

Each process owns workspace storage and, for LLM workflows, an instance tree. Coding processes use full Git clones; other processes may declare no repositories. Storage survives worker replacement, but process volumes require independent backups; see [Backup and upgrades](../admin/backup-and-upgrades.md).

## Workspace layouts

### Local runner

```text
<storage.process_workspaces_dir>/<instanceId>/
├── AGENTS.md                 # Aggregated instructions across components
├── <project-key>/            # Full Git clone per component (optional)
└── .leitwerk/
    ├── components.json       # Component locator and branch metadata
    └── skills/               # Attached skills

<storage.tree_files_dir>/<instanceId>.jsonl
```

### Docker and Kubernetes

Isolated workers mount persistent process storage at `/state/`:

```text
/state/
├── workspace/                # Multi-component workspace root
├── tree/primary.jsonl        # Active JSONL execution tree
├── pi-agent/                 # Materialized Pi resource snapshot & 0600 credentials
├── pi-resource-bundles/      # Immutable content-addressed snapshots
│   ├── <sha256>.tar
│   └── starts/<turn-start-id>.json
├── tooling/
│   ├── mise/                 # Process-local installs, cache, state, and shims
│   └── mise-preparation/latest.json
└── tmp/                      # Temporary execution artifacts
```

Workers upload JSONL snapshots via `PUT /internal/workers/:instanceId/session-snapshot`; the server never reads live worker volumes. On Kubernetes, PVC capacity covers the entire `/state` volume and is never resized after provisioning.

## Repository management

By default, every declared project gets a full Git clone on its assigned work branch; any failure aborts worker bootstrap before turn acceptance.

- **`repositoryCheckout: "on_demand"`:** Startup creates no clones. `checkout_repository({ projectKey, revision? })` materializes a full clone on demand, updates `.leitwerk/components.json` and `AGENTS.md`, and pins an optional 40/64-char commit SHA across recovery (failing if dirty).
- **`repositoryCheckout: "none"`:** Retains project bindings for server integration-tool authorization without preparing clones or exposing `checkout_repository`. This mode does not remove local worker tools or server mutation tools; processes must authorize only the tools each turn needs.
- **Reconciliation:** Bootstrap preserves local work and never overwrites an active checkout from a watcher; shared coding processes reconcile source branches during preparation and publication (see [Coding README](../../extensions/coding/README.md)).
- **`developmentTools: true`:** Runs stock `mise install` and `mise ls --current --json` sequentially at each repository root before readiness/acceptance (no nested directory scan, generated config, or `[env]` propagation guarantee), placing shims first on `PATH` (using `/state/tooling/mise` in containers or host mise locally) and terminating the installer process group on timeout or abort.

### HTTPS and SSH repository access

Clones use credential-free locators. For HTTPS, the owning integration supplies an origin credential narrowed on the server to the exact project repository URL and exposed via a temporary `0600` Git helper. For SSH, `git-ssh` supplies pinned keys and `known_hosts`. Ordinary tool subprocesses receive sanitized environments without repository credentials; see [Security](../admin/security.md).

## Resource aggregation

During worker bootstrap:

- **`AGENTS.md`:** Concatenates component `AGENTS.md` files into workspace root `AGENTS.md` with source provenance comments.
- **Managed Pi resources:** The server packages non-secret settings, models, extensions, prompts, and bundled skills into an immutable tar snapshot. The worker verifies its digest, caches it in `pi-resource-bundles/`, and materializes it into `pi-agent/` alongside ephemeral `0600` credential files. Ambient `~/.pi/agent` and repository `.pi` resources are ignored.
- **Attached skills:** Launch-pinned [skill packs](../extensions/skill-packs.md) and dependencies enter the snapshot by revision and survive extension upgrades or removal.

## Pi session tree

The JSONL session file stores prompts, reasoning, tool calls, results, and outcomes. Top-level turns start root branches (`parentId: null`); review or analysis turns can fork side branches and restore the primary branch on completion. Snapshot reads verify snapshot generation and retry concurrent replacements up to three times.

## Local Pi session transfer

An authenticated operator creates a one-hour bearer grant (`SQLite` stores only its SHA-256 hash). Claiming via `@leitwerk-dev/pi-session-transfer` waits for quiescence, acquires an exclusive export reservation, stops any idle writable worker, and streams a Zstandard-compressed tar containing only `workspace/`, `session.jsonl` (`tree/primary.jsonl`), and a versioned manifest—excluding `pi-agent/`, tooling caches, and credentials.

Local import validates Pi session format V3, branch/HEAD evidence, regular/directory/confined-relative-symlink entries, and transfer limits, rewrites session `cwd`, strips `parentSession` metadata, writes a local receipt (`origin` + grant + token hash), and updates local Pi state. Future local turns use local Pi's configuration and credentials.

## Retention and deletion

Retained storage survives worker replacement and private-daemon restarts: Kubernetes Docker daemon replacement waits for old Pod deletion before starting another daemon under `/state/tooling/docker` and never auto-resets retained images, containers, or volumes on failure or retry. Configured retention periods govern automatic cleanup of completed/errored/aborted volumes (`kubernetes.process_volume.reclaim_on_close: true` discards completed/aborted Kubernetes PVCs immediately on close). Explicit deletion (`DELETE /api/processes/:id`) revokes transfer grants and immediately removes workspaces, session trees, result images, and Kubernetes process namespaces.
