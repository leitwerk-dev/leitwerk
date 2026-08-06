-- Adds durable connect-token authentication for container-runner worker leases.
-- Apply to configured storage.sqlite_path before starting code that expects
-- restart adoption of Docker/Kubernetes workers to survive server restarts.
-- Existing active leases cannot be adopted without this hash and should be
-- respawned from their retained process volume/PVC.

ALTER TABLE worker_leases ADD COLUMN connect_token_hash text;
