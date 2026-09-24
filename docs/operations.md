# Backup and upgrades

The server owns durable process state in SQLite and retained session snapshots.
Workers also keep workspace files and tooling in process storage. Protect both
when unpushed work matters; a database backup cannot reconstruct lost workspace edits.

## What to protect

| Data | Protection needed |
| --- | --- |
| SQLite and server-owned tree/result files | Back up together at a consistent recovery point. |
| Credential encryption key | Store securely with a recoverable association to the database backup. Losing it makes encrypted credentials unreadable. |
| Configuration and extension versions | Retain the files and immutable artifact references needed to recreate the deployment. |
| Process volumes | Arrange independent volume backups or snapshots if workspace recovery is required. Leitwerk does not manage their backup or restoration. |

Retention controls when storage is deleted. It is not a backup policy. A startup
migration backup protects the SQLite migration boundary, not the entire deployment.

## Take a consistent backup

1. Prevent new launches and operator mutations during the maintenance interval.
2. Stop the server and ensure no process still writes server-owned storage. If also
   backing up process volumes, quiesce their workers before snapshotting them.
3. Copy the complete configured server storage, including SQLite and its sidecar files,
   session snapshots, and result files. Preserve ownership and permissions.
4. Back up configuration and the encryption key securely. Record the server, worker,
   extension, and schema-compatible release versions.
5. Check that the backup can be read, then restart and verify readiness.

An online SQLite backup is suitable for the database alone when taken with SQLite's
backup API. Copying a live `.sqlite` file by itself is not a consistent backup,
and does not synchronize it with external tree or result files.

The [local Docker guide](docker-deployment-guide.md#backup) gives a stopped-server
archive command. Deployment-specific backup tooling may provide a different
consistent procedure; verify its scope before relying on it.

## Restore

Restore first into an isolated environment with a compatible server version and
the matching encryption key. Prevent that environment from polling real providers
or resuming external writes during inspection.

Verify database integrity, retained process history, required artifacts, and any
separately protected workspaces. Never start two servers against the same storage.
Before a production restore, stop the old server and preserve the current data for
investigation. Restoring an older backup discards everything committed after it;
external systems are not rolled back with the database.

## Upgrade and rollback

Before changing versions:

1. Check the target release's compatibility requirements and release notes.
2. Back up server storage and the key; independently protect process volumes as needed.
3. Keep server and worker API versions compatible. Retain the previous artifact digests.
4. Validate the candidate configuration and extensions. Use Kubernetes candidate-image
   [preflight](kubernetes-deployment-guide.md#23-safe-singleton-upgrades) where available.
5. Replace the singleton server, then verify `/api/ready`, authentication, startup
   recovery, and one representative process before reopening access.

Startup backs up file-backed SQLite before applying known migrations atomically.
It validates the result and rejects unknown schema drift. Do not delete or reset
configured storage to get past an upgrade failure.

An image rollback is safe only if the old binary accepts the current schema and
retained state. Helm `--atomic` does not reverse database migrations. If a candidate
has committed a migration, restoring an old Deployment may leave it unable to start.
Prefer a compatible forward fix; a database restore requires an explicit recovery
point and acceptance of later data loss.

For private Docker workers, check `docker info --format '{{.Driver}}'` before
upgrading. Verify replacement against retained `overlay2` stores. Processes using
a different storage driver must finish under the old image unless a separate data
migration is planned. Retaining the directory does not make another driver's
images usable by `overlay2`.

## Diagnose startup

| Observation | Meaning / next step |
| --- | --- |
| `/api/health` returns 200, `/api/ready` returns 503 | The process is alive but reconciliation or start hooks have not completed. Inspect server logs. |
| Waiting for worker capacity | Normal queued admission. Inspect capacity and active work before changing limits. |
| Worker bootstrap fails | Inspect image compatibility, repository access, resource verification, and runtime prerequisites. No turn attempt exists before acceptance. |
| Turn fails after acceptance | Use its recorded failure and the offered Retry or Continue action. |
| Schema mismatch | Preserve storage and inspect the migration/version mismatch. Never reset automatically. |
| Credential decryption fails | Check the key/database pairing. Replacing the key cannot decrypt old values. |

Diagnostic traces can contain repository or tool output. Sanitize them before
sharing; never publish encryption keys, bearer links, or provider credentials.
