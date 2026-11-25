# Backup and upgrades

The server owns durable process state in SQLite and retained session snapshots/diagnostics under `storage.tree_files_dir`. Workers keep repository checkouts and tooling in process volumes. Protect both when unpushed workspace edits matter—a database backup cannot reconstruct lost process volumes.

## What to protect

| Asset | Requirement |
| --- | --- |
| SQLite database + `tree_files_dir` | Back up together at a consistent recovery point. |
| `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` | Store securely paired with the database backup; losing it makes encrypted provider credentials unreadable. |
| Config and release references | Retain `leitwerk.yaml`, deployment manifests/values, and immutable image/extension digests. |
| Process volumes | Snapshot or back up independently if workspace recovery is required. Leitwerk does not back up or restore worker volumes. |

Retention (`workers.cleanup.*`) controls deletion, not backups. Automatic pre-migration SQLite copies protect only the migration step, not the whole deployment.

## Consistent backup

1. Pause new launches and operator mutations.
2. Stop the server so nothing writes SQLite or `tree_files_dir`. Quiesce workers before snapshotting process volumes.
3. Copy SQLite (including `-wal` and `-shm` if present) together with `tree_files_dir`, preserving ownership and permissions.
4. Record release versions/digests and protect `leitwerk.yaml` and `LEITWERK_CREDENTIAL_ENCRYPTION_KEY`.
5. Verify the archive is readable, then restart the server and check `/api/ready`.

SQLite's online backup API creates a consistent copy of the database alone, but does not synchronize it with `tree_files_dir`. Never back up a live `.sqlite` file by raw file copy. See [Docker backup](deploy-docker.md#backup) or `scripts/k8s/docker-desktop/backup.sh` for stopped-server commands.

## Restore

1. Restore into an isolated environment first, using a schema-compatible server binary and the matching encryption key. Disable real provider polling and external writes during verification.
2. Verify database integrity, retained process history, artifacts, and any restored process volumes.
3. Never start two servers against the same storage. Before replacing production, stop the old server and preserve the current data for investigation.

Restoring an older backup discards work committed after that point; external systems (Git, issues, merge requests) are not rolled back with SQLite.

## SQLite migrations and upgrades

On startup against an existing file-backed database, the server checks `KNOWN_MIGRATIONS`:

1. Validates the pre-migration baseline schema against all non-migrating tables.
2. Runs `PRAGMA wal_checkpoint(TRUNCATE)` and copies the database (and any `-wal`/`-shm` sidecars) to `<sqlite_dir>/backups/<filename>.<timestamp>.bak`.
3. Applies matched migrations atomically inside a transaction (`BEGIN` … `COMMIT`), re-verifies schema compatibility, and runs `PRAGMA foreign_key_check` (rolling back on any error).
4. Rejects unknown schema drift with a startup error (`DatabaseSchemaMismatchError`).

Never delete or reset configured storage to bypass a migration or schema error.

### Upgrade checklist

1. Review target release compatibility notes and keep server/worker versions compatible; keep previous image digests.
2. Take a consistent backup of server storage, config, and the encryption key (plus process volumes if needed).
3. Validate candidate configuration and extensions; in Kubernetes, run the `pre-upgrade` [preflight Job](deploy-kubernetes.md#safe-singleton-upgrades).
4. Replace the singleton server, then verify `/api/ready`, authentication, startup recovery, and one test process before reopening traffic.

### Rollback limits

- Rolling back an image is safe only if the older binary accepts the current SQLite schema.
- Helm `--atomic` does not reverse a migration committed during real startup. Prefer a schema-compatible forward fix; rolling back SQLite requires restoring an earlier backup and accepting data loss after that point.
- For private Docker workers, verify `docker info --format '{{.Driver}}'` before upgrading against retained `overlay2` stores; processes created under a different storage driver must finish on the old image unless migrated separately.

## Startup failure triage

| Symptom | Meaning and action |
| --- | --- |
| `/api/health` is `200`, `/api/ready` is `503` | Server is alive, but reconciliation or extension start hooks have not completed (or shutdown started). Inspect server logs. |
| Process queued for worker capacity | Normal admission queueing under `workers.max_parallel_processes`. Check active work before raising limits. |
| Worker bootstrap failure | Check image compatibility, repository access, resource snapshot verification, and runtime prerequisites. No turn attempt exists before acceptance. |
| Turn failure after acceptance | Inspect failure details in the Chronicle and use the offered Retry or Continue action. |
| Schema mismatch (`DatabaseSchemaMismatchError`) | Preserve storage and compare server binary version against database schema. Never auto-reset. |
| Credential decryption failure | Verify `LEITWERK_CREDENTIAL_ENCRYPTION_KEY` matches the database. Generating a new key cannot decrypt existing rows. |

Diagnostic traces can contain repository or tool output. Sanitize them before sharing, and never share encryption keys, session-transfer links, or provider credentials.
