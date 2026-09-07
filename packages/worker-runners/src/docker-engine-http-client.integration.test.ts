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

async function fakeEngine(apiVersion: unknown) {
	const requests: Array<{ method: string | undefined; path: string; body: unknown }> = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString("utf8");
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		requests.push({
			method: request.method,
			path: pathname,
			body: body ? JSON.parse(body) : null,
		});
		response.setHeader("Content-Type", "application/json");
		if (pathname === "/version") {
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
