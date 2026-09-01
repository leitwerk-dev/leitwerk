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

## 6. Storage Retention & Cleanup

Process storage is retained across worker restarts and cleaned up based on process outcome. Pi resource bundles are content-addressed and are not overwritten or garbage-collected independently. A retry resolves the latest authorized resources. It reuses the digest when their content is unchanged and adds a new bundle when their content changed.

- **Retention Thresholds:** Storage is retained after process completion or failure according to `storage.completed_process_retention` and `storage.error_process_retention` settings before worker volumes are released.
- **Explicit Deletion:** Deleting a process (`DELETE /api/processes/:id`) revokes transfer grants and attempts, then immediately purges all managed workspace storage, session tree files, stored result images, and Kubernetes process namespaces.
