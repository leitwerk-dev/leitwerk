import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerContainerSpec } from "./docker-engine-client.js";
import { createDockerEngineHttpClient } from "./docker-engine-http-client.js";

const servers: Server[] = [];

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

async function fakeEngine(
	apiVersion: unknown,
	replies: Record<string, { status?: number; body?: unknown; raw?: string }> = {},
) {
	const requests: Array<{
		method: string | undefined;
		path: string;
		query: Record<string, string>;
		body: unknown;
	}> = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString("utf8");
		const url = new URL(request.url ?? "/", "http://localhost");
		const pathname = url.pathname;
		requests.push({
			method: request.method,
			path: pathname,
			query: Object.fromEntries(url.searchParams),
			body: body ? JSON.parse(body) : null,
		});
		response.setHeader("Content-Type", "application/json");
		const reply = replies[`${request.method} ${pathname}`];
		if (reply) {
			response.statusCode = reply.status ?? 200;
			response.end(reply.raw ?? JSON.stringify(reply.body));
		} else if (pathname === "/version") {
			response.end(JSON.stringify({ ApiVersion: apiVersion }));
		} else if (request.method === "POST" && pathname.endsWith("/containers/create")) {
			response.end(JSON.stringify({ Id: "helper-container" }));
		} else {
			response.statusCode = 404;
			response.end(JSON.stringify({ message: "Unexpected endpoint" }));
		}
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
	return { socket: `http://127.0.0.1:${address.port}`, requests };
}

function helperSpec(): DockerContainerSpec {
	return {
		name: "session-export-helper",
		image: "example/worker:1",
		env: [],
		labels: {},
		mounts: [
			{
				source: "retained-state",
				target: "/state/workspace",
				volumeSubpath: "workspace",
				readOnly: true,
			},
			{
				source: "retained-state",
				target: "/state/tree",
				volumeSubpath: "tree",
				readOnly: true,
			},
		],
		networkMode: "leitwerk",
		privileged: false,
	};
}

describe("Docker HTTP volume subpaths", () => {
	it.each([
		undefined,
		"1.45",
		"v1.46",
	])("uses an explicit supported API and sends confined mounts with configured version %s", async (apiVersion) => {
		const engine = await fakeEngine("1.46");
		const client = createDockerEngineHttpClient({ socket: engine.socket, apiVersion });
		await expect(client.createContainer(helperSpec())).resolves.toEqual({
			id: "helper-container",
		});
		const create = engine.requests.find((request) => request.method === "POST");
		expect(create?.path).toBe(`/v${apiVersion?.replace(/^v/, "") ?? "1.46"}/containers/create`);
		expect(create?.body).toMatchObject({
			HostConfig: {
				Mounts: [
					{
						Type: "volume",
						Source: "retained-state",
						Target: "/state/workspace",
						ReadOnly: true,
						VolumeOptions: { Subpath: "workspace", NoCopy: true },
					},
					{
						Type: "volume",
						Source: "retained-state",
						Target: "/state/tree",
						ReadOnly: true,
						VolumeOptions: { Subpath: "tree", NoCopy: true },
					},
				],
			},
		});
	});

	it.each([
		"1.44",
		undefined,
		"invalid",
	])("does not create a helper when the daemon advertises unsupported API %s", async (apiVersion) => {
		const engine = await fakeEngine(apiVersion);
		const client = createDockerEngineHttpClient({ socket: engine.socket });
		await expect(client.createContainer(helperSpec())).rejects.toThrow("API 1.45+");
		expect(engine.requests.map((request) => request.path)).toEqual(["/version"]);
	});

	it("rejects an explicit older API instead of silently dropping subpaths", async () => {
		const engine = await fakeEngine("1.46");
		const client = createDockerEngineHttpClient({ socket: engine.socket, apiVersion: "1.44" });
		await expect(client.createContainer(helperSpec())).rejects.toThrow("API 1.45+");
		expect(engine.requests).toEqual([]);
	});

	it("keeps ordinary full-volume worker creation available on older engines", async () => {
		const engine = await fakeEngine("1.44");
		const client = createDockerEngineHttpClient({ socket: engine.socket });
		await client.createContainer({
			...helperSpec(),
			mounts: [{ source: "retained-state", target: "/state" }],
		});
		expect(engine.requests.map((request) => request.path)).toEqual(["/containers/create"]);
		expect(engine.requests[0]?.body).toMatchObject({
			HostConfig: {
				Mounts: [{ Type: "volume", Source: "retained-state", Target: "/state", ReadOnly: false }],
			},
		});
	});
});

describe("Docker HTTP requests", () => {
	it("encodes label filters and maps container summaries", async () => {
		const engine = await fakeEngine("1.46", {
			"GET /v1.46/containers/json": { body: [{ Id: "worker", Labels: { a: "b" } }] },
		});
		const client = createDockerEngineHttpClient({ socket: engine.socket, apiVersion: "v1.46" });
		await expect(client.listContainers({ labels: { a: "b", c: "d" } })).resolves.toEqual([
			{ id: "worker", labels: { a: "b" } },
		]);
		expect(engine.requests[0].query).toEqual({
			filters: JSON.stringify({ label: ["a=b", "c=d"] }),
		});
	});

	it("rejects malformed JSON through the pending request", async () => {
		const engine = await fakeEngine("1.46", { "GET /containers/worker/json": { raw: "not JSON" } });
		const client = createDockerEngineHttpClient({ socket: engine.socket });
		await expect(client.inspectContainer("worker")).rejects.toBeInstanceOf(SyntaxError);
	});

	it("sends the container configuration to Docker Engine", async () => {
		const spec: DockerContainerSpec = {
			name: "orch-worker",
			image: "example/worker:latest",
			env: ["A=B"],
			command: ["node", "/app/helper.js"],
			labels: { "leitwerk.dev/component": "worker" },
			mounts: [
				{ source: "/host/state", target: "/state" },
				{ source: "/host/ca.pem", target: "/leitwerk/server-ca.pem", readOnly: true },
			],
			networkMode: "leitwerk",
			privileged: true,
			runtime: "sysbox-runc",
			nanoCpus: 1_000_000_000,
			memoryBytes: 512 * 1024 * 1024,
		};

		const engine = await fakeEngine("1.46");
		const client = createDockerEngineHttpClient({ socket: engine.socket });
		await client.createContainer(spec);
		const mapped = engine.requests[0];

		expect(mapped.method).toBe("POST");
		expect(mapped.path).toBe("/containers/create");
		expect(mapped.query).toEqual({ name: "orch-worker" });
		expect(mapped.body).toMatchObject({
			Image: "example/worker:latest",
			Env: ["A=B"],
			Cmd: ["node", "/app/helper.js"],
			Labels: { "leitwerk.dev/component": "worker" },
			HostConfig: {
				NetworkMode: "leitwerk",
				Privileged: true,
				Runtime: "sysbox-runc",
				NanoCpus: 1_000_000_000,
				Memory: 512 * 1024 * 1024,
				Mounts: [
					{ Type: "bind", Source: "/host/state", Target: "/state", ReadOnly: false },
					{
						Type: "bind",
						Source: "/host/ca.pem",
						Target: "/leitwerk/server-ca.pem",
						ReadOnly: true,
					},
				],
			},
		});
	});
});
