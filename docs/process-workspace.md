# Process Workspace & Storage Layout

Every Leitwerk process instance owns a dedicated workspace directory and a durable JSONL instance tree. While coding workflows populate this directory with full project repository clones, non-repository or tool-based workflows may operate without local clones or direct filesystem access. This document details how workspace storage, aggregated instructions, skills, and agent execution trees are laid out and managed across worker restarts.

---

## 1. Workspace Layouts

The physical layout of process storage depends on the configured worker runner environment.

### Local & Development Runner Layout

When running locally or during automated testing, workspaces and tree files live under server-configured paths on the host filesystem:

```text
<storage.process_workspaces_dir>/<instanceId>/
├── AGENTS.md                 # Aggregated instructions across project components
├── <project-key>/            # Full Git clone for a specific project component (optional)
└── .leitwerk/
    ├── components.json       # Component locator and branch mapping metadata
    └── skills/               # Aggregated workspace skills

<storage.tree_files_dir>/<instanceId>.jsonl  # Execution tree containing all turn interactions
```

### Isolated Container Layout (Docker & Kubernetes)

Isolated worker runners (Docker containers or Kubernetes pods) mount persistent process storage at `/state/`:

```text
/state/
├── workspace/               # Monorepo / multi-component workspace root
├── tree/primary.jsonl       # Active JSONL execution tree
├── pi-agent/                # Materialized non-secret Pi resource snapshot & credentials (mode 0600)
├── pi-resource-bundles/     # Immutable snapshots retained for the process lifetime
│   ├── <sha256>.tar
│   └── starts/<turn-start-id>.json
├── tooling/
│   ├── mise/                # Process-local installs, cache, state, and shims
│   └── mise-preparation/latest.json # Bounded current-tool evidence
└── tmp/                     # Temporary execution artifacts
```

> [!NOTE]
> Physical workers upload JSONL session snapshots to the server via `PUT /session-snapshot` so the server can compute browser read models without inspecting Docker volumes or Kubernetes PVCs directly.

---

## 2. Repository Management

A Leitwerk process can target zero, one, or multiple repositories. When repositories are declared, Leitwerk creates a full Git clone for each repository checked out to its assigned work branch. Workspace preparation fails if any clone, checkout, branch creation, manifest write, or aggregate write fails. The worker must not report readiness or start a turn with a partial workspace. A later retry repairs missing or stale components before reporting readiness. Processes that do not target repositories run without local clones or filesystem dependencies.

A process may opt into development-tool preparation. The worker then runs stock `mise install`
and `mise ls --current --json` sequentially at each repository root in repository-key order. It
does not scan nested directories, generate mise configuration, interpret ecosystem files, or
install package dependencies. Docker and Kubernetes store mise state in the process volume.
Local workers use the host mise installation and host mise storage. Mise shims lead `PATH` for
agent commands; full mise shell activation and `[env]` propagation are not guaranteed.
Cancellation and timeouts terminate the installer process group, including child processes
that outlive mise. The worker waits for termination before finishing preparation.

---

## 3. Resource Aggregation

During worker bootstrap, Leitwerk aggregates instructions and agent capabilities into the workspace:

- **`AGENTS.md` Concatenation:** Combines `AGENTS.md` files across target repositories into a unified root `AGENTS.md` with source provenance comments (`<!-- leitwerk: source=repo/AGENTS.md -->`).
- **Managed Agent Environment:** The server packages extensions, skills, and settings into an immutable snapshot. The worker verifies and persists each snapshot in `pi-resource-bundles/`, then materializes it in `pi-agent/` alongside temporary credentials. Credentials never enter the persisted bundle.

---

## 4. Pi Session Tree (`.jsonl`)

The instance tree is the Pi session file (`/state/tree/primary.jsonl` or `<storage.tree_files_dir>/<instanceId>.jsonl`). Workers stream session snapshots to the server via `PUT /session-snapshot` after key turn events so the server can render UI read models.

```text
               [Root Entry (parentId: null)]
                             |
                     [Turn 1: Plan]
                             |
               +-------------+-------------+
               |                           |
       [Turn 2: Implement]         [Turn 2b: Code Review]
               |                           |
        [Active Leaf]               [Review Leaf]
```

- **File Content:** Stores user prompts, assistant reasoning, tool calls, tool results, and outcome data.
- **Session Root:** Top-level turns begin at a root entry (`parentId: null`) without prior prompt context.
- **Branching:** Review or analysis turns run on side branches within the same session file and can restore context upon completion.

---

## 5. Local Pi Session Transfer

An authenticated operator can create an expiring local-transfer link from a process with a primary Pi session. Link creation only stores a hashed bearer grant; workspace reading starts when local Pi claims it.

The transfer exporter waits for already accepted work and automatic successors to reach a stable `waiting`, `error`, `completed`, or `aborted` state. It then reserves the process, removes the idle worker and writable lease, pre-scans retained storage, and streams a tar+Zstandard archive. The archive contains only `workspace/`, `tree/primary.jsonl` as `session.jsonl`, and a versioned manifest. It excludes `pi-agent/`, tooling and dependency caches, credentials, temporary state, and unrelated volume paths.

Local import preserves regular files, executable modes, timestamps, and confined relative symlinks. It accepts Pi session format V3 only, validates project branch/HEAD evidence and the append-ordered entry tree, rewrites the session cwd, removes source `parentSession` metadata, and stores the validated conversation in local Pi's normal session directory without migration. Future turns use local Pi configuration and credentials; they are not part of the server process.

Independent root branches remain valid in the imported tree. Local session switching does not wait for server acknowledgement. A completed receipt lets the operator reopen the local session and retry acknowledgement with the same link without copying again.

## 6. Storage Retention, Backup & Cleanup

Process storage persists across physical-worker replacement and remains available while the process is retained. Kubernetes Docker processes keep daemon data under `/state/tooling/docker` on the same single process PVC; replacement waits for the old Pod to disappear before starting another daemon. This lifecycle persistence is not disaster-recovery durability. Leitwerk does not manage process-volume backup or restoration. Server-owned durable state remains the Leitwerk-managed disaster-recovery boundary.

Private-daemon startup may retry once after an early exit. Retry and startup failure preserve the Docker data directory; they never reset retained images, containers, or volumes automatically.

Operators may independently snapshot or back up process volumes and are responsible for retention and restore testing. Without that protection, losing a process volume can lose unpushed repository changes and tooling state that the server database cannot reconstruct. Pi resource bundles are content-addressed and are not overwritten or garbage-collected independently, but they share the process volume's loss model. A retry resolves the latest authorized resources. It reuses the digest when their content is unchanged and adds a new bundle when their content changed.

- **Retention Thresholds:** Storage is retained after process completion or error according to `workers.cleanup.completed_process_retention` and `workers.cleanup.error_process_retention` before worker volumes are released. Retention controls cleanup timing; it does not create a backup.
- **Explicit Deletion:** Deleting a process (`DELETE /api/processes/:id`) revokes transfer grants and immediately purges all managed workspace storage, session tree files, stored result images, and Kubernetes process namespaces.
