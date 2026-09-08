import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createKubernetesHttpApiClient } from "./kubernetes-http-client.js";

const servers: http.Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
});

async function listen(handler: http.RequestListener): Promise<string> {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP test server");
	return `http://127.0.0.1:${address.port}`;
}

describe("Kubernetes HTTP API client", () => {
	it("retries one plain bad-request response for an idempotent GET", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		let namespaceReads = 0;
		const apiServerUrl = await listen((request, response) => {
			requests.push({ method: request.method ?? "", url: request.url ?? "" });
			if (request.method === "GET") {
				namespaceReads += 1;
				if (namespaceReads === 1) {
					response.writeHead(400, { "Content-Type": "text/plain" });
					response.end("400 Bad Request");
					return;
				}
				response.writeHead(404, { "Content-Type": "application/json" });
				response.end('{"kind":"Status","reason":"NotFound"}');
				return;
			}
			response.writeHead(201, { "Content-Type": "application/json" });
			response.end("{}");
		});
		const client = createKubernetesHttpApiClient({ apiServerUrl });

		await client.ensureNamespace({
			apiVersion: "v1",
			kind: "Namespace",
			metadata: { name: "leitwerk-process-test", labels: { managed: "true" } },
		});

		expect(requests).toEqual([
			{ method: "GET", url: "/api/v1/namespaces/leitwerk-process-test" },
			{ method: "GET", url: "/api/v1/namespaces/leitwerk-process-test" },
			{ method: "POST", url: "/api/v1/namespaces" },
		]);
	});

	it("retries a plain bad-request response when deleting a pod", async () => {
		let requests = 0;
		const apiServerUrl = await listen((_request, response) => {
			requests += 1;
			if (requests === 1) {
				response.writeHead(400, { "Content-Type": "text/plain" });
				response.end("400 Bad Request");
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end("{}");
		});
		const client = createKubernetesHttpApiClient({ apiServerUrl });

		await client.deletePod("worker-pod", "process-namespace", { gracePeriodSeconds: 0 });

		expect(requests).toBe(2);
	});

	it("does not retry structured Kubernetes bad requests when deleting a pod", async () => {
		let requests = 0;
		const apiServerUrl = await listen((_request, response) => {
			requests += 1;
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end('{"kind":"Status","reason":"BadRequest"}');
		});
		const client = createKubernetesHttpApiClient({ apiServerUrl });

		await expect(
			client.deletePod("worker-pod", "process-namespace", { gracePeriodSeconds: 0 }),
		).rejects.toThrow("failed with HTTP 400");
		expect(requests).toBe(1);
	});
});
