# Run Leitwerk in the sandbox

Start Leitwerk on your machine, check that the server is ready, and follow a local worker until it produces a plan for review. The sandbox runs a scripted model locally, so you can try it without a model account or Docker.

Use a Leitwerk source checkout on macOS or Linux with Git, Node.js 26.x, and npm.

## Start the sandbox

From the checkout root, install dependencies and start Leitwerk.

```sh
npm ci
npm run dev:sandbox
```

Once the sandbox prints its URLs, check readiness from another terminal.

```sh
curl --fail http://127.0.0.1:18082/api/ready
```

The server returns `{"status":"ready"}` when it can accept work. Open the [local sandbox controls](http://127.0.0.1:18082/__local).

## Check that a worker can run

1. Select **repository-change**, click **Start fresh scenario**, and follow the new process link.
2. Wait for **Approve plan** to appear. The worker has connected, completed its planning turn, and left the process waiting for a decision.
3. Reload the page and confirm the plan and **Approve plan** action are still available. The sandbox keeps its SQLite database and execution history under `.leitwerk/sandbox/scripted/`.

Stop the sandbox with `Ctrl+C` when finished. [Sandbox storage and recovery](https://github.com/leitwerk-dev/leitwerk/blob/main/sandbox/README.md#storage-and-recovery)

## Choose a deployment

- [Run a local process with a live model](local-quickstart.md) from a source checkout.
- [Deploy on a single Docker host](deploy-docker.md) with Docker Compose.
- [Deploy to Kubernetes](deploy-kubernetes.md) with Helm and persistent volumes.
