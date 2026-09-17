import { once } from "node:events";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { testWorkspace } from "../test-workspace.js";
import { runWorkerStartupBenchmark } from "./benchmark.js";

async function fixture(
	options: {
		lostResponse?: boolean;
		running?: boolean;
		failPoll?: boolean;
		multipleTurns?: boolean;
		failedTurn?: boolean;
		abort?: boolean;
	} = {},
) {
	const { root } = testWorkspace();
	const calls: { method: string; path: string; key?: string; body?: unknown; auth?: string }[] = [];
	const launches = new Map<string, string>();
	const controller = options.abort ? new AbortController() : undefined;
	let loseResponse = options.lostResponse;
	const detailReads = new Map<string, number>();
	const readBody = async (request: IncomingMessage) => {
		let text = "";
		for await (const part of request) text += part;
		return text ? JSON.parse(text) : undefined;
	};
	const server = createServer(async (request, response) => {
		const url = request.url ?? "";
		const key = request.headers["idempotency-key"] as string | undefined;
		calls.push({
			method: request.method ?? "GET",
			path: url,
			key,
			body: await readBody(request),
			auth: request.headers.authorization,
		});
		response.setHeader("content-type", "application/json");
		const send = (value: unknown) => response.end(JSON.stringify(value));
		if (url === "/api/launchers")
			return send({
				launchers: [
					{
						id: "example.launch",
						modelConfigSchema: {
							availableProfiles: [
								{
									id: "example-model",
									availability: "available",
									token: "must-not-copy-profile-fields",
								},
							],
						},
					},
				],
			});
		if (request.method === "POST") {
			if (!key) {
				response.statusCode = 400;
				return send({});
			}
			if (!launches.has(key)) launches.set(key, `run-${launches.size}`);
			if (loseResponse) {
				loseResponse = false;
				response.destroy();
				return;
			}
			return send({ launchRunId: launches.get(key), instanceId: launches.get(key) });
		}
		if (url.startsWith("/api/launch-runs/")) {
			if (options.failPoll) {
				response.statusCode = 503;
				return send({});
			}
			const id = url.split("/").at(-1);
			return send({
				launchRun: { id, instanceId: id, status: "completed", createdAt: "2026-09-15T00:00:00Z" },
			});
		}
		if (url.endsWith("/ui-snapshot"))
			return send({
				startup: {
					workerStarts: [
						{
							workerLeaseId: "lease",
							observations: [
								{ milestone: "image_cached" },
								{ milestone: "first_text", observedAt: "2026-09-15T00:00:00.150Z" },
							],
							intervals: {},
						},
					],
				},
			});
		if (url.startsWith("/api/processes/")) {
			controller?.abort();
			const reads = (detailReads.get(url) ?? 0) + 1;
			detailReads.set(url, reads);
			return send({
				process: {
					lifecycleStatus:
						options.running || options.failedTurn || (options.multipleTurns && reads < 2)
							? "active"
							: "completed",
				},
				turnRecords: [
					{ status: options.failedTurn ? "failed" : options.running ? "running" : "succeeded" },
				],
			});
		}
		response.statusCode = 404;
		send({});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing server port");
	const apiConfig = path.join(root, "api.yaml");
	writeFileSync(
		apiConfig,
		`base_url: http://127.0.0.1:${address.port}\napi_token: synthetic-benchmark-token\n`,
	);
	return {
		root,
		calls,
		launches,
		detailReads,
		options: {
			apiConfig,
			launcherId: "example.launch",
			modelProfileId: "example-model",
			launcherInput: { prompt: "example input" },
			title: "Example",
			candidate: "candidate-a",
			output: path.join(root, "evidence"),
			samples: 2,
			timeoutMs: 1000,
			pollIntervalMs: 5,
			signal: controller?.signal,
		},
	};
}

it("retries lost launch responses with one identity and writes private evidence for warmups and measured samples", async () => {
	const fixtureData = await fixture({ lostResponse: true });
	const { options, calls, launches } = fixtureData;
	const result = await runWorkerStartupBenchmark({ ...options, warmups: 1 });
	expect(result.succeeded).toBe(true);
	expect(result.samples).toHaveLength(3);
	expect(launches.size).toBe(3);
	const posts = calls.filter((call) => call.method === "POST");
	expect(posts).toHaveLength(4);
	expect(posts[0].key).toBe(posts[1].key);
	expect(posts[0].body).toEqual({
		title: "Example",
		launcherInput: { prompt: "example input" },
		modelConfig: { defaultModelProfileId: "example-model" },
	});
	expect(calls.every((call) => call.auth === "Bearer synthetic-benchmark-token")).toBe(true);
	expect(calls.some((call) => call.method === "DELETE")).toBe(false);
	const inputs = readFileSync(path.join(options.output, "inputs.json"), "utf8");
	expect(inputs).not.toContain("synthetic-benchmark-token");
	expect(inputs).not.toContain("must-not-copy-profile-fields");
	expect(JSON.parse(inputs).provenance).toBeNull();
	expect(readFileSync(result.reportPath, "utf8")).toContain(
		"Measured launches: 2 / 2; warm-ups: 1",
	);
	expect(
		readFileSync(path.join(options.output, "launches.jsonl"), "utf8").trim().split("\n"),
	).toHaveLength(3);
	for (const file of [
		options.apiConfig,
		result.reportPath,
		path.join(options.output, "results.jsonl"),
	])
		expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(statSync(options.output).mode & 0o777).toBe(0o700);
	await expect(runWorkerStartupBenchmark(options)).rejects.toThrow(/EEXIST/);
	expect(launches.size).toBe(3);
});

it.each([
	[
		"a timed-out generation",
		{ running: true },
		{ samples: 3, timeoutMs: 500, pollIntervalMs: 20 },
		{ outcome: "timeout" },
	],
	["a polling failure", { failPoll: true }, {}, { outcome: "failed", error: "API HTTP 503" }],
	["an interrupted launch", { abort: true }, {}, { outcome: "interrupted" }],
	["a failed active process", { failedTurn: true }, {}, { outcome: "failed" }],
] as const)("stops after %s and retains its launch and instance IDs", async (_, setup, overrides, expected) => {
	const { options, launches } = await fixture(setup);
	const result = await runWorkerStartupBenchmark({ ...options, ...overrides });
	expect(result.complete).toBe(false);
	expect(result.succeeded).toBe(false);
	expect(result.samples).toHaveLength(1);
	expect(result.samples[0]).toMatchObject({
		...expected,
		launchRunId: "run-0",
		instanceId: "run-0",
	});
	expect(launches.size).toBe(1);
});

it("rejects unavailable launcher/model selections before creating processes", async () => {
	const { options, launches } = await fixture();
	await expect(runWorkerStartupBenchmark({ ...options, launcherId: "missing" })).rejects.toThrow(
		"launcher is unavailable",
	);
	await expect(
		runWorkerStartupBenchmark({ ...options, modelProfileId: "missing" }),
	).rejects.toThrow("profile is unavailable");
	expect(launches.size).toBe(0);
});

it("waits for process completion after a successful first turn before starting another sample", async () => {
	const { options, detailReads, calls } = await fixture({ multipleTurns: true });
	const result = await runWorkerStartupBenchmark(options);
	expect(result.succeeded).toBe(true);
	expect([...detailReads.values()]).toEqual([2, 2]);
	const secondPost = calls.findIndex(
		(call) => call.method === "POST" && call.key === result.samples[1].idempotencyKey,
	);
	expect(
		calls.slice(0, secondPost).filter((call) => call.path === "/api/processes/run-0"),
	).toHaveLength(2);
});
