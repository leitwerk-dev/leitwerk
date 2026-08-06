# Local Docker Deployment

This guide explains how to deploy Leitwerk on a single machine using Docker and Docker Compose. Use this deployment mode when you want container-isolated worker processes without running a full Kubernetes cluster.

---

## 1. Prerequisites & Host Constraints

### Prerequisites
- Docker Engine or Docker Desktop
- Docker Compose v2
- OpenSSL, `curl`, and `jq`

> [!IMPORTANT]
> **Single Daemon Limit:** Run at most one Docker-backed Leitwerk server per Docker daemon. Multiple server instances on the same daemon can interfere with container supervision and volume adoption.

---

## 2. Deployment Setup & Configuration

### 2.1. Environment Directories
Set deployment environment variables and create outside-checkout storage directories:

```bash
export REVISION="$(git rev-parse --short HEAD)"
export DEPLOY_ROOT="$HOME/.local/share/leitwerk/deployments/leitwerk-${REVISION}"
mkdir -p "$DEPLOY_ROOT/config" "$DEPLOY_ROOT/secrets" "$DEPLOY_ROOT/backups"
```

### 2.2. Configuration File (`leitwerk.yaml`)
Create `$DEPLOY_ROOT/config/leitwerk.yaml` with required Docker runner settings:

```yaml
server:
  base_url: "http://localhost:18080"
workers:
  runner: "docker"
  docker:
    image: "leitwerk-worker-generic:${REVISION}"
storage:
  database_path: "/state/leitwerk.sqlite"
```

### 2.3. Secrets & Image Building
Generate the 32-byte credential encryption key and build revision-tagged images from the repository root:

```bash
# Generate encryption secret
printf 'LEITWERK_CREDENTIAL_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > "$DEPLOY_ROOT/secrets/credentials.env"
chmod 600 "$DEPLOY_ROOT/secrets/credentials.env"

# Build revision-pinned container images
docker build -f deploy/images/Dockerfile.server -t "leitwerk-server:${REVISION}" .
docker build -f deploy/images/Dockerfile.worker-generic -t "leitwerk-worker-generic:${REVISION}" .
```

---

## 3. Launching & Health Verification

### 3.1. Start Services
Launch the server using Docker Compose and the generated secret file:

```bash
docker compose --env-file "$DEPLOY_ROOT/secrets/credentials.env" \
  -f deploy/docker/docker-compose.yml up -d
```

### 3.2. Verify System Health
Confirm the Fastify server and SQLite database are ready:

```bash
curl -s http://localhost:18080/api/health | jq .
# Expected output: { "status": "ok" }
```

---

## 4. Operational Procedures

### 4.1. Backup & Restore
- **Backup:** Copy SQLite database storage to `$DEPLOY_ROOT/backups/`:
  ```bash
  sqlite3 /state/leitwerk.sqlite ".backup '$DEPLOY_ROOT/backups/leitwerk-$(date +%Y%m%d%H%M%S).sqlite'"
  ```
- **Restore:** Stop server containers, replace `/state/leitwerk.sqlite` with the backup file, and restart services.

### 4.2. Upgrade & Rollback
- **Upgrade:** Export updated `REVISION`, build new container images, and execute `docker compose up -d`.
- **Rollback:** Re-export previous `REVISION` tag and run `docker compose up -d --force-recreate`.

### 4.3. Teardown & Deletion
Stop container services and remove managed worker volumes:

```bash
docker compose -f deploy/docker/docker-compose.yml down -v
```
