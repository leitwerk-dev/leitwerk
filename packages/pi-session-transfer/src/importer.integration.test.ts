import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ReplacedSessionContext,
} from "@earendil-works/pi-coding-agent";
import type { CancellableLoader } from "@earendil-works/pi-tui";
import {
	createTransferArchive,
	parseTransferLink,
	scanPortableWorkspace,
} from "@leitwerk-dev/session-transfer";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteTransferAttempt } from "./client.js";
import { importTransfer } from "./importer.js";
import leitwerkSessionTransfer from "./index.js";
import { LocalTransferState } from "./local-state.js";

const roots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections();
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function transferFixture(
	options: {
		streamGate?: Promise<void>;
		cancelGate?: Promise<void>;
		acknowledgementGate?: Promise<void>;
	} = {},
) {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-import-test-"));
	roots.push(root);
	const workspace = path.join(root, "source-workspace");
	const sessionFile = path.join(root, "source-session.jsonl");
	const agentDir = path.join(root, "agent");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	await mkdir(workspace);
	await writeFile(path.join(workspace, "work.txt"), "retained work");
	await writeFile(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "server-session",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: workspace,
		})}\n`,
	);
	const preflight = await scanPortableWorkspace({ workspaceRoot: workspace, sessionFile });
	const archive = await buffer(
		createTransferArchive({
			workspaceRoot: workspace,
			sessionFile,
			preflight,
			manifest: {
				version: 1,
				instanceId: "agt_1",
				createdAt: "2026-09-01T00:00:00.000Z",
				session: { sourceCwd: workspace, cwdRelativeToWorkspace: "." },
				projects: [],
			},
		}),
	);
	const attempt: RemoteTransferAttempt = {
		id: "tra_1",
		grantId: "trg_1",
		instanceId: "agt_1",
		state: "exporting",
		phase: "ready_to_stream",
		leaseUntil: new Date(Date.now() + 90_000).toISOString(),
		hardDeadline: new Date(Date.now() + 3_600_000).toISOString(),
		entriesTotal: preflight.entriesTotal,
		logicalBytesTotal: preflight.logicalBytesTotal,
		compressedBytes: archive.length,
		streamSha256: createHash("sha256").update(archive).digest("hex"),
		failureCode: null,
	};
	const requests: string[] = [];
	const streamStarted = Promise.withResolvers<void>();
	const cancelStarted = Promise.withResolvers<void>();
	const acknowledgementStarted = Promise.withResolvers<void>();
	const server = http.createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		void (async () => {
			if (request.url?.endsWith("/stream")) {
				response.writeHead(200);
				response.flushHeaders();
				streamStarted.resolve();
				await options.streamGate;
				attempt.state = "awaiting_ack";
				attempt.phase = "awaiting_ack";
				response.end(archive);
				return;
			}
			if (request.method === "DELETE") {
				cancelStarted.resolve();
				await options.cancelGate;
				attempt.state = "cancelled";
				attempt.phase = "cancelled";
			}
			if (request.url?.endsWith("/acknowledge")) {
				acknowledgementStarted.resolve();
				await options.acknowledgementGate;
				response.writeHead(409, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: "Transfer lease expired" }));
				return;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ attempt }));
		})().catch((error) => response.destroy(error as Error));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected test server address");
	const rawLink = `http://127.0.0.1:${address.port}/api/session-transfers/agt_1/trg_1#token=abcdefghijklmnopqrstuvwxyz123456`;
	const link = parseTransferLink(rawLink);
	return {
		root,
		agentDir,
		link,
		rawLink,
		requests,
		streamStarted: streamStarted.promise,
		cancelStarted: cancelStarted.promise,
		acknowledgementStarted: acknowledgementStarted.promise,
		state: new LocalTransferState(agentDir),
		destination: path.join(root, "imported"),
	};
}

async function commandHarness(fixture: Awaited<ReturnType<typeof transferFixture>>) {
	let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	await leitwerkSessionTransfer({
		registerCommand(_name, command) {
			handler = command.handler;
		},
	} as ExtensionAPI);
	if (!handler) throw new Error("Transfer command was not registered");
	const registeredHandler = handler;
	let loader: CancellableLoader | undefined;
	let progressClosed = false;
	const notices: string[] = [];
	const switched: string[] = [];
	const ctx = {
		mode: "tui",
		cwd: fixture.root,
		waitForIdle: async () => {},
		ui: {
			input: async () => fixture.destination,
			confirm: async () => true,
			notify: (message: string) => notices.push(message),
			custom: (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) =>
				new Promise((resolve) => {
					loader = factory(
						{ requestRender() {} } as Parameters<typeof factory>[0],
						{ fg: (_color: string, text: string) => text } as Parameters<typeof factory>[1],
						{} as Parameters<typeof factory>[2],
						(result) => {
							progressClosed = true;
							loader?.dispose();
							resolve(result);
						},
					) as CancellableLoader;
				}),
		},
		switchSession: async (
			sessionPath: string,
			options: Parameters<ExtensionCommandContext["switchSession"]>[1],
		) => {
			switched.push(sessionPath);
			await options?.withSession?.(ctx as unknown as ReplacedSessionContext);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	return {
		run: () => registeredHandler(fixture.rawLink, ctx),
		cancel: () => {
			if (!loader) throw new Error("Expected progress loader");
			loader.handleInput("\u001b");
		},
		progressClosed: () => progressClosed,
		notices,
		switched,
	};
}

it("cancels during local validation before reserving or writing the destination", async () => {
	const fixture = await transferFixture();
	const controller = new AbortController();
	const phases: string[] = [];
	await expect(
		importTransfer({
			link: fixture.link,
			destination: fixture.destination,
			state: fixture.state,
			signal: controller.signal,
			onProgress(progress) {
				phases.push(progress.phase);
				if (progress.phase === "validating_local") controller.abort();
			},
		}),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(phases).not.toContain("finishing_import");
	await expect(stat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
	expect(
		await readdir(path.join(fixture.agentDir, "leitwerk-session-transfer", "transfers")),
	).toEqual([]);
	expect((await readdir(fixture.root)).some((name) => name.startsWith(".leitwerk-transfer-"))).toBe(
		false,
	);
	expect(fixture.requests.some((request) => request.startsWith("DELETE "))).toBe(true);
});

it("keeps the cancellation view open until the importer has unwound", async () => {
	const stream = Promise.withResolvers<void>();
	const cancellation = Promise.withResolvers<void>();
	const fixture = await transferFixture({
		streamGate: stream.promise,
		cancelGate: cancellation.promise,
	});
	const command = await commandHarness(fixture);
	const running = command.run();
	try {
		await fixture.streamStarted;
		command.cancel();
		await fixture.cancelStarted;
		expect(command.progressClosed()).toBe(false);
		expect(command.notices).toEqual([]);
	} finally {
		cancellation.resolve();
		stream.resolve();
		await running;
	}
	expect(command.progressClosed()).toBe(true);
	expect(command.notices).toContain(
		"Transfer cancelled. The link can be retried while it remains valid.",
	);
	await expect(stat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
});

it("opens and reopens a completed import while acknowledgement remains unavailable", async () => {
	const acknowledgement = Promise.withResolvers<void>();
	const fixture = await transferFixture({ acknowledgementGate: acknowledgement.promise });
	const command = await commandHarness(fixture);
	try {
		await command.run();
		await fixture.acknowledgementStarted;
		expect(command.switched).toHaveLength(1);
		expect(await readFile(path.join(fixture.destination, "work.txt"), "utf8")).toBe(
			"retained work",
		);
		expect(await fixture.state.receipt(fixture.link)).toMatchObject({
			sessionPath: command.switched[0],
		});
	} finally {
		acknowledgement.resolve();
	}
	await expect
		.poll(() =>
			command.notices.some((notice) => notice.includes("acknowledgement is still pending")),
		)
		.toBe(true);
	await command.run();
	expect(command.switched).toEqual([command.switched[0], command.switched[0]]);
	await expect
		.poll(() => fixture.requests.filter((request) => request.endsWith("/acknowledge")).length)
		.toBe(2);
	expect(fixture.requests.filter((request) => request.endsWith("/stream"))).toHaveLength(1);
	expect(
		fixture.requests.filter(
			(request) => request.startsWith("POST ") && request.endsWith("/attempts"),
		),
	).toHaveLength(1);
});

it("does not discard an earlier recovery record when another attempt cannot begin", async () => {
	const fixture = await transferFixture();
	const temporaryDirectory = path.join(fixture.root, "earlier-import");
	await mkdir(temporaryDirectory);
	await writeFile(path.join(temporaryDirectory, fixture.state.markerName()), "earlier-owner\n");
	await writeFile(path.join(temporaryDirectory, "work.txt"), "incomplete retained work");
	await fixture.state.begin(fixture.link, {
		attemptId: "earlier",
		temporaryDirectory,
		ownerId: "earlier-owner",
	});
	await expect(
		importTransfer({
			link: fixture.link,
			destination: fixture.destination,
			state: fixture.state,
			signal: new AbortController().signal,
			onProgress() {},
		}),
	).rejects.toThrow("still has recovery state");
	expect(await readFile(path.join(temporaryDirectory, "work.txt"), "utf8")).toBe(
		"incomplete retained work",
	);
	expect(
		await readdir(path.join(fixture.agentDir, "leitwerk-session-transfer", "transfers")),
	).toHaveLength(1);
});
