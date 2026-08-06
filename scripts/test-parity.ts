import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

interface ExtensionEntryLike {
	entryPath: string;
}

interface ProcessDetailResponse {
	process: { id: string; lifecycleStatus: string };
	workerLease: { state?: string } | null;
	events: Array<{ eventType?: string; data?: unknown }>;
	turnRecords: unknown[];
}

interface CapturedOutput {
	stdout: string[];
	stderr: string[];
}

interface StartedServer {
	baseUrl: string;
	child: ChildProcess;
	output: CapturedOutput;
	tempDir: string;
}

class FatalWaitError extends Error {}

function stripSourceCondition(nodeOptions: string | undefined): string | undefined {
	const filtered = (nodeOptions ?? "")
		.split(/\s+/u)
		.filter((token) => token.length > 0 && token !== "--conditions=source");
	return filtered.length > 0 ? filtered.join(" ") : undefined;
}

function getParityEnv(configPath: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEITWERK_CONFIG_PATH: configPath,
		LEITWERK_RUNTIME_LANE: "dist",
	};
	for (const key of [
		"LEITWERK_LOCAL_WORKER_COMMAND",
		"LEITWERK_LOCAL_WORKER_ARGS_JSON",
		"HOST",
		"PORT",
		"LEITWERK_BASE_URL",
	])
		delete env[key];
	const sanitizedNodeOptions = stripSourceCondition(env.NODE_OPTIONS);
	if (sanitizedNodeOptions) {
		env.NODE_OPTIONS = sanitizedNodeOptions;
	} else {
		delete env.NODE_OPTIONS;
	}
	return env;
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Could not resolve an ephemeral port")));
			} else {
				server.close((error) => (error ? reject(error) : resolve(address.port)));
			}
		});
	});
}

async function waitFor<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (predicate(value)) {
				return value;
			}
		} catch (error) {
			if (error instanceof FatalWaitError) {
				throw error;
			}
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Timed out waiting for parity condition");
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body)}`);
	}
	return body;
}

async function assertLauncher(baseUrl: string, launcherId: string): Promise<void> {
	const body = (await fetchJson(`${baseUrl}/api/launchers`)) as {
		launchers?: Array<{ id?: string }>;
	};
	assert(
		body.launchers?.some((launcher) => launcher.id === launcherId),
		`expected launcher ${launcherId} to be available`,
	);
}

async function launchNow(
	baseUrl: string,
	launcherId: string,
	launcherInput: Record<string, unknown>,
): Promise<string> {
	const body = (await fetchJson(`${baseUrl}/api/launchers/${launcherId}/launch`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ launcherInput, modelConfig: {}, schedule: { mode: "now" } }),
	})) as { process?: { id?: string } };
	assert(body.process?.id, `expected launcher ${launcherId} to create a process`);
	return body.process.id;
}

async function waitForProcess(
	baseUrl: string,
	instanceId: string,
	predicate: (detail: ProcessDetailResponse) => boolean,
	options: {
		timeoutMs?: number;
		failFast?: (detail: ProcessDetailResponse) => void;
	} = {},
): Promise<ProcessDetailResponse> {
	return (await waitFor(
		async () => {
			const detail = (await fetchJson(
				`${baseUrl}/api/processes/${encodeURIComponent(instanceId)}`,
			)) as ProcessDetailResponse;
			options.failFast?.(detail);
			return detail;
		},
		predicate,
		options.timeoutMs ?? 30_000,
	)) as ProcessDetailResponse;
}

function captureOutput(child: ChildProcess): CapturedOutput {
	const output: CapturedOutput = { stdout: [], stderr: [] };
	child.stdout?.on("data", (chunk: Buffer | string) => output.stdout.push(String(chunk)));
	child.stderr?.on("data", (chunk: Buffer | string) => output.stderr.push(String(chunk)));
	return output;
}

async function stopChild(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 5_000).unref();
	});
	return { code: child.exitCode, signal: child.signalCode };
}

function formatCapturedLogs(output: CapturedOutput): string {
	const stdout = output.stdout.join("").trim();
	const stderr = output.stderr.join("").trim();
	return [
		stdout && `--- server stdout ---\n${stdout}`,
		stderr && `--- server stderr ---\n${stderr}`,
	]
		.filter(Boolean)
		.join("\n");
}

async function waitForHealthyServer(server: StartedServer): Promise<void> {
	try {
		await waitFor(
			async () => {
				if (server.child.exitCode !== null || server.child.signalCode !== null) {
					const logs = formatCapturedLogs(server.output);
					throw new FatalWaitError(
						`Server exited before health check passed (code=${server.child.exitCode}, signal=${server.child.signalCode}).${logs ? `\n${logs}` : ""}`,
					);
				}
				return await fetchJson(`${server.baseUrl}/api/health`);
			},
			(health) => (health as { status?: string }).status === "ok",
			30_000,
		);
	} catch (error) {
		if (error instanceof FatalWaitError) {
			throw error;
		}
		const logs = formatCapturedLogs(server.output);
		const lastError = error instanceof Error ? `\nLast error: ${error.message}` : "";
		throw new Error(
			`Timed out waiting for server health check.${logs ? `\n${logs}` : ""}${lastError}`,
		);
	}
}

function baseConfigLines(tempDir: string, port: number): string[] {
	return [
		"server:",
		"  host: 127.0.0.1",
		`  port: ${port}`,
		`  base_url: http://127.0.0.1:${port}`,
		"storage:",
		`  sqlite_path: ${JSON.stringify(path.join(tempDir, "leitwerk.sqlite"))}`,
		`  process_workspaces_dir: ${JSON.stringify(path.join(tempDir, "workspaces"))}`,
		`  tree_files_dir: ${JSON.stringify(path.join(tempDir, "trees"))}`,
		"pi:",
		`  agent_dir: ${JSON.stringify(path.join(tempDir, "pi"))}`,
	];
}

async function startBuiltServer(
	repoRoot: string,
	tempPrefix: string,
	extraConfigLines: (tempDir: string) => string[],
): Promise<StartedServer> {
	const serverEntry = path.join(repoRoot, "packages/server/dist/main.js");
	if (!existsSync(serverEntry)) {
		throw new Error("Built server entrypoint is missing. Run npm run parity:build first.");
	}
	const tempParentDir = path.join(repoRoot, ".leitwerk", "tmp");
	mkdirSync(tempParentDir, { recursive: true });
	const tempDir = await mkdtemp(path.join(tempParentDir, tempPrefix));
	const port = await getFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const configPath = path.join(tempDir, "leitwerk.yaml");
	await writeFile(
		configPath,
		`${[...baseConfigLines(tempDir, port), ...extraConfigLines(tempDir)].join("\n")}\n`,
		"utf8",
	);
	const child = spawn(process.execPath, [serverEntry], {
		cwd: repoRoot,
		env: getParityEnv(configPath),
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { baseUrl, child, output: captureOutput(child), tempDir };
}

async function withBuiltServer(
	repoRoot: string,
	tempPrefix: string,
	extraConfigLines: (tempDir: string) => string[],
	run: (server: StartedServer) => void | Promise<void>,
	options: { assertCleanShutdown?: boolean; logOnError?: boolean } = {},
): Promise<void> {
	const server = await startBuiltServer(repoRoot, tempPrefix, extraConfigLines);
	let runError: unknown;
	try {
		await waitForHealthyServer(server);
		await run(server);
	} catch (error) {
		runError = error;
		const logs = options.logOnError ? formatCapturedLogs(server.output) : "";
		if (logs) {
			console.error(logs);
		}
	}
	const exit = await stopChild(server.child);
	await rm(server.tempDir, { recursive: true, force: true });
	if (runError) {
		throw runError;
	}
	if (
		!options.assertCleanShutdown ||
		exit.signal === "SIGTERM" ||
		exit.code === 143 ||
		exit.code === 0
	) {
		return;
	}
	throw new Error(
		`Server did not shut down cleanly (code=${exit.code}, signal=${exit.signal}).\n${formatCapturedLogs(server.output)}`,
	);
}

async function assertBuiltDistLoaderUsesBuiltEntries(repoRoot: string): Promise<void> {
	const originalLane = process.env.LEITWERK_RUNTIME_LANE;
	process.env.LEITWERK_RUNTIME_LANE = "dist";
	try {
		const extensionRuntimeDist = pathToFileURL(
			path.join(repoRoot, "packages/extension-runtime/dist/index.js"),
		).href;
		const module = (await import(extensionRuntimeDist)) as {
			resolveExtensionEntries(options: {
				startDir: string;
				sources: string[];
			}): Promise<ExtensionEntryLike[]>;
		};
		const [entry] = await module.resolveExtensionEntries({
			startDir: repoRoot,
			sources: ["./extensions/showcase-processes"],
		});
		assert(entry, "expected one resolved extension entry");
		assert.equal(
			entry.entryPath,
			path.join(repoRoot, "extensions", "showcase-processes", "dist", "index.js"),
			"dist runtime lane should resolve built extension entrypoints",
		);
	} finally {
		if (originalLane === undefined) {
			delete process.env.LEITWERK_RUNTIME_LANE;
		} else {
			process.env.LEITWERK_RUNTIME_LANE = originalLane;
		}
	}
}

function writeDefaultWorkerSmokeExtension(tempDir: string, repoRoot: string): string {
	const extensionDir = path.join(tempDir, "default-worker-smoke-extension");
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(
		path.join(extensionDir, "package.json"),
		`${JSON.stringify(
			{
				name: "@leitwerk-dev/default-worker-smoke-extension",
				version: "0.0.0-smoke",
				type: "module",
				leitwerk: { extension: { import: "./index.js" } },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const processSdkUrl = pathToFileURL(
		path.join(repoRoot, "packages", "process-sdk", "dist", "index.js"),
	).href;
	writeFileSync(
		path.join(extensionDir, "index.js"),
		`import { automaticTurn, defineProcess, emptyParamsCodec } from ${JSON.stringify(processSdkUrl)};\n\nconst stateCodec = { parse: () => ({}), serialize: (value) => value };\nconst smokeProcess = defineProcess({\n\tid: "default_worker_smoke_process",\n\tdisplayName: "Default Worker Smoke",\n\tentry: "complete",\n\tparamsCodec: emptyParamsCodec,\n\tstateCodec,\n\tinitialState: () => ({}),\n\tturns: { complete: automaticTurn({ description: "Complete without an LLM call", run: () => ({ outcome: "done", params: {} }), turnEnd: { outcome: "done", params: {}, complete: true } }) },\n\tlaunchers(api) {\n\t\tapi.launcher({ id: "default_worker_smoke_process.launcher", label: "Default Worker Smoke", description: "Launches an automatic process through the default worker entrypoint", visibility: "ui", ui: { card: { title: "Default Worker Smoke" }, launchConfigSchema: { id: "default_worker_smoke_form", title: "Default Worker Smoke", fields: [], submitLabel: "Run smoke" }, resolveLaunchConfig: () => ({ ok: true, launchConfig: { processId: "default_worker_smoke_process", params: {}, startTurnId: "complete" } }) } });\n\t},\n});\n\nexport default { manifest: { id: "default-worker-smoke", version: "0.0.0" }, setupCatalog(api) { api.registerProcess(smokeProcess); } };\n`,
		"utf8",
	);
	return extensionDir;
}

function writeParityModelProviderExtension(tempDir: string, repoRoot: string): string {
	const extensionDir = path.join(tempDir, "parity-model-provider-extension");
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(
		path.join(extensionDir, "package.json"),
		`${JSON.stringify(
			{
				name: "@leitwerk-dev/parity-model-provider-extension",
				version: "0.0.0-smoke",
				type: "module",
				leitwerk: { extension: { import: "./index.js" } },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const processSdkUrl = pathToFileURL(
		path.join(repoRoot, "packages", "process-sdk", "dist", "index.js"),
	).href;
	writeFileSync(
		path.join(extensionDir, "index.js"),
		`import { builtinPiProvider, defineModelProvider, defineModelProviders } from ${JSON.stringify(processSdkUrl)};\n\nconst provider = defineModelProvider({\n\tid: "parity-fixture",\n\tparseConfig: () => ({ config: {} }),\n\tworker: builtinPiProvider("openai"),\n\tmodels: () => [{ modelId: "fixture-model", availability: "available" }],\n\tsecrets: () => ({}),\n});\n\nexport default {\n\tmanifest: { id: "parity-model-provider", version: "0.0.0" },\n\tmodelProviders: defineModelProviders((rawConfig) => [{ definition: provider, rawConfig }]),\n};\n`,
		"utf8",
	);
	return extensionDir;
}

async function runServerStartSmoke(repoRoot: string): Promise<void> {
	await withBuiltServer(
		repoRoot,
		"leitwerk-server-start-",
		() => [
			"workers:",
			"  runner: local",
			"  max_parallel_processes: 1",
			"  log_worker_events_to_stdout: false",
			"extension_loading:",
			"  sources: []",
			"extensions: {}",
		],
		(server) => {
			assert.equal(
				server.output.stderr.join("").trim(),
				"",
				`Server wrote to stderr during startup.\n${formatCapturedLogs(server.output)}`,
			);
		},
		{ assertCleanShutdown: true },
	);
	console.info("[test:server-start] OK");
}

async function runDefaultWorkerSmoke(repoRoot: string): Promise<void> {
	await withBuiltServer(
		repoRoot,
		"leitwerk-default-worker-",
		(tempDir) => {
			const extensionDir = writeDefaultWorkerSmokeExtension(tempDir, repoRoot);
			return [
				"workers:",
				"  runner: local",
				"  max_parallel_processes: 1",
				"  log_worker_events_to_stdout: false",
				"extension_loading:",
				"  sources:",
				`    - ${JSON.stringify(extensionDir)}`,
				"extensions: {}",
			];
		},
		async ({ baseUrl }) => {
			const launcherId = "default_worker_smoke_process.launcher";
			await assertLauncher(baseUrl, launcherId);
			const instanceId = await launchNow(baseUrl, launcherId, {});
			const completedDetail = await waitForProcess(
				baseUrl,
				instanceId,
				(detail) => detail.process.lifecycleStatus === "completed",
				{
					failFast(detail) {
						if (
							detail.process.lifecycleStatus === "error" ||
							detail.workerLease?.state === "failed"
						) {
							throw new FatalWaitError(
								`Default worker smoke process failed before completion. Lease state: ${detail.workerLease?.state ?? "<none>"}. Recent events: ${JSON.stringify(detail.events.slice(-8), null, 2)}`,
							);
						}
					},
				},
			);
			assert(
				completedDetail.turnRecords.length > 0 ||
					completedDetail.events.some(
						(event) =>
							event.eventType === "turn_started" || event.eventType === "turn_outcome_recorded",
					),
				"expected the packaged default worker entrypoint to execute the automatic turn",
			);
		},
		{ logOnError: true },
	);
	console.info("[test:default-worker] OK");
}

async function runParity(repoRoot: string): Promise<void> {
	await assertBuiltDistLoaderUsesBuiltEntries(repoRoot);
	await withBuiltServer(
		repoRoot,
		"leitwerk-parity-",
		(tempDir) => {
			const providerExtensionDir = writeParityModelProviderExtension(tempDir, repoRoot);
			return [
				"  model_profiles:",
				"    - id: parity-fixture",
				"      provider: parity-fixture",
				"      model_id: fixture-model",
				"      thinking_level: off",
				"workers:",
				"  runner: local",
				"  max_parallel_processes: 1",
				"local_worker:",
				"  command: node",
				"  args:",
				`    - ${JSON.stringify(path.join(repoRoot, "packages", "test-support", "dist", "stub-worker-entry.js"))}`,
				"extension_loading:",
				"  sources:",
				`    - ${JSON.stringify(path.join(repoRoot, "extensions", "showcase-processes"))}`,
				`    - ${JSON.stringify(providerExtensionDir)}`,
				"extensions: {}",
			];
		},
		async ({ baseUrl }) => {
			const launcherId = "single_prompt_process.single_prompt_ui";
			await assertLauncher(baseUrl, launcherId);

			const rendererId = "@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome";
			const rendererBody = (await fetchJson(
				`${baseUrl}/api/ui/renderers/${encodeURIComponent(rendererId)}`,
			)) as { moduleUrl?: string; extensionManifestId?: string };
			assert.equal(rendererBody.extensionManifestId, "showcase-processes");
			assert(rendererBody.moduleUrl, "expected the renderer endpoint to expose a moduleUrl");

			const assetResponse = await fetch(`${baseUrl}${rendererBody.moduleUrl}`);
			assert.equal(assetResponse.status, 200, "expected built renderer assets to be served");
			assert.match(
				assetResponse.headers.get("content-type") ?? "",
				/text\/javascript/u,
				"expected renderer assets to be served as JavaScript",
			);

			const instanceId = await launchNow(baseUrl, launcherId, {
				prompt: "Say hello from the parity lane.",
			});
			let sawWorkerEvidence = false;
			const completedDetail = await waitForProcess(
				baseUrl,
				instanceId,
				(detail) => detail.process.lifecycleStatus === "completed",
				{
					failFast(detail) {
						sawWorkerEvidence ||= Boolean(detail.workerLease);
						sawWorkerEvidence ||= detail.turnRecords.length > 0;
						sawWorkerEvidence ||= detail.events.some(
							(event) =>
								event.eventType === "turn_started" || event.eventType === "turn_outcome_recorded",
						);
						if (
							detail.process.lifecycleStatus === "error" ||
							detail.workerLease?.state === "failed"
						) {
							throw new FatalWaitError(
								`Parity process failed before completion. Lease state: ${detail.workerLease?.state ?? "<none>"}. Recent events: ${JSON.stringify(detail.events.slice(-8), null, 2)}`,
							);
						}
					},
				},
			);

			assert.equal(completedDetail.process.lifecycleStatus, "completed");
			assert(
				sawWorkerEvidence,
				"expected the built worker runtime to execute the launched process",
			);
		},
		{ logOnError: true },
	);
}

async function main(): Promise<void> {
	const repoRoot = process.cwd();
	if (process.argv.includes("--server-start-only")) {
		await runServerStartSmoke(repoRoot);
		return;
	}
	if (process.argv.includes("--default-worker-only")) {
		await runDefaultWorkerSmoke(repoRoot);
		return;
	}
	await runParity(repoRoot);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
