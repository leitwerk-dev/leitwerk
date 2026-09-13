import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";

it.each([
	false,
	true,
])("keeps startup retries alive and permits shutdown during backoff (stop=%s)", async (stopDuringBackoff) => {
	const server = createServer();
	const sockets = new WebSocketServer({ noServer: true });
	let attempts = 0;
	server.on("upgrade", (request, socket, head) => {
		attempts += 1;
		if (attempts < 3) {
			socket.destroy();
			return;
		}
		sockets.handleUpgrade(request, socket, head, (client) => {
			client.once("message", () => client.close(1008, "test complete"));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test address");
	const child = spawn(
		process.execPath,
		[
			"--no-deprecation",
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`
  import { createWebSocketWorkerIpc } from ${JSON.stringify(new URL("./ipc.ts", import.meta.url).href)};
  const ipc = createWebSocketWorkerIpc({ serverUrl: "http://127.0.0.1:${address.port}", instanceId: "test", workerId: "test", token: "test", reconnect: true, onDiagnostic: (message) => { if (${stopDuringBackoff} && message.includes("close=")) queueMicrotask(() => { ipc.stop(); console.log("stopped during backoff"); }); } });
  ipc.onError(() => { ipc.stop(); console.log("connected and stopped"); });
  ipc.start();
 `,
		],
		{
			cwd: fileURLToPath(new URL("../../../", import.meta.url)),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = once(child, "exit");
	const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		expect(await exited).toEqual([0, null]);
		expect(stderr).toBe("");
		expect(stdout).toContain(
			stopDuringBackoff ? "stopped during backoff" : "connected and stopped",
		);
		expect(attempts).toBe(stopDuringBackoff ? 1 : 3);
	} finally {
		clearTimeout(timeout);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		for (const client of sockets.clients) client.terminate();
		sockets.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
