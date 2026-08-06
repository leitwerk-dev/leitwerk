import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	builtinPiProvider,
	createCapabilityToken,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	humanTurn,
	llmTurn,
	toProcessGraphView,
} from "@leitwerk-dev/process-sdk";
import { setProcessTurnTransitions } from "@leitwerk-dev/process-sdk/runtime-internals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildExtensionCatalog,
	importExtensionModules,
	resolveExtensionEntries,
} from "./extension-loader.js";
import { LEITWERK_RUNTIME_LANE_ENV } from "./runtime-lane.js";
import { createLoadedExtensionModuleForTest } from "./testing.js";

const tempDirs: string[] = [];
const originalRuntimeLane = process.env[LEITWERK_RUNTIME_LANE_ENV];

beforeEach(() => {
	delete process.env[LEITWERK_RUNTIME_LANE_ENV];
});

afterEach(async () => {
	if (originalRuntimeLane === undefined) {
		delete process.env[LEITWERK_RUNTIME_LANE_ENV];
	} else {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = originalRuntimeLane;
	}
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(
	workspaces: unknown = ["packages/*", "extensions/*"],
): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-extension-loader-"));
	tempDirs.push(root);
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "root", private: true, workspaces }),
	);
	// Create empty packages and extensions directories to satisfy workspace patterns
	await mkdir(path.join(root, "packages"), { recursive: true });
	await mkdir(path.join(root, "extensions"), { recursive: true });
	return root;
}

async function createExtensionPackage(
	root: string,
	opts: {
		withDist: boolean;
		discover?: boolean;
		extensionMetadata?: unknown;
		piMetadata?: unknown;
	},
) {
	const pkgDir = path.join(root, "extensions", "example");
	await mkdir(path.join(pkgDir, "src"), { recursive: true });
	await writeFile(
		path.join(pkgDir, "package.json"),
		JSON.stringify({
			name: "@example/example",
			leitwerk: {
				extension: opts.extensionMetadata ?? {
					source: "./src/index.ts",
					import: "./dist/index.js",
				},
				...(opts.discover === false ? { discover: false } : {}),
				...(opts.piMetadata === undefined ? {} : { pi: opts.piMetadata }),
			},
		}),
	);
	await writeFile(
		path.join(pkgDir, "src", "index.ts"),
		"const manifest = { id: 'x', version: '0.1.0' }; export default { manifest };\n",
	);
	if (opts.withDist) {
		await mkdir(path.join(pkgDir, "dist"), { recursive: true });
		await writeFile(
			path.join(pkgDir, "dist", "index.js"),
			"export default { manifest: { id: 'dist-x', version: '0.1.0' } };\n",
		);
	}
	return pkgDir;
}

describe("resolveExtensionEntries", () => {
	it("returns an empty entry list when no extension sources are configured", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		await createExtensionPackage(root, { withDist: false });

		await expect(resolveExtensionEntries({ startDir: root, sources: [] })).resolves.toEqual([]);
	});

	it("resolves configured relative package directories", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, { withDist: false });

		const entries = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});

		expect(entries).toEqual([
			{
				packageName: "@example/example",
				packageDir: pkgDir,
				entryPath: path.join(pkgDir, "src", "index.ts"),
			},
		]);
	});

	it("resolves configured package directories to built entrypoints in the dist lane", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "dist";
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, { withDist: true });

		const entries = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});

		expect(entries).toEqual([
			{
				packageName: "@example/example",
				packageDir: pkgDir,
				entryPath: path.join(pkgDir, "dist", "index.js"),
			},
		]);
	});

	it("still allows explicitly configured quarantined extensions", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, {
			withDist: false,
			discover: false,
		});

		const entries = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});

		expect(entries).toEqual([
			{
				packageName: "@example/example",
				packageDir: pkgDir,
				entryPath: path.join(pkgDir, "src", "index.ts"),
			},
		]);
	});

	it("rejects legacy string package metadata", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "dist";
		const root = await createWorkspace();
		await createExtensionPackage(root, {
			withDist: true,
			extensionMetadata: "./src/index.ts",
		});

		await expect(
			resolveExtensionEntries({
				startDir: root,
				sources: ["./extensions/example"],
			}),
		).rejects.toThrow(
			"Extension package '@example/example' must declare leitwerk.extension as an object with source and import string paths",
		);
	});

	it("resolves Pi entries and resources through the active source lane", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, {
			withDist: false,
			piMetadata: {
				worker: { source: "./src/pi-worker.ts", import: "./dist/pi-worker.js" },
				server: { source: "./src/pi-server.ts", import: "./dist/pi-server.js" },
				resources: { skills: ["./skills"], prompts: ["./prompts"] },
			},
		});
		await mkdir(path.join(pkgDir, "skills"));
		await mkdir(path.join(pkgDir, "prompts"));

		const [entry] = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});

		expect(entry.pi).toEqual({
			workerEntryPath: path.join(pkgDir, "src", "pi-worker.ts"),
			serverEntryPath: path.join(pkgDir, "src", "pi-server.ts"),
			resources: {
				skillDirectories: [path.join(pkgDir, "skills")],
				promptDirectories: [path.join(pkgDir, "prompts")],
			},
		});
	});

	it("resolves Pi entries through the active dist lane", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "dist";
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, {
			withDist: true,
			piMetadata: {
				worker: { source: "./src/pi-worker.ts", import: "./dist/pi-worker.js" },
				server: { source: "./src/pi-server.ts", import: "./dist/pi-server.js" },
			},
		});
		const [entry] = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});
		expect(entry.pi?.workerEntryPath).toBe(path.join(pkgDir, "dist", "pi-worker.js"));
		expect(entry.pi?.serverEntryPath).toBe(path.join(pkgDir, "dist", "pi-server.js"));
	});

	it("rejects Pi entries and resources outside their owning package", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		await createExtensionPackage(root, {
			withDist: false,
			piMetadata: {
				worker: { source: "../escaped.ts", import: "./dist/pi-worker.js" },
			},
		});
		await expect(
			resolveExtensionEntries({ startDir: root, sources: ["./extensions/example"] }),
		).rejects.toThrow("must resolve inside extension package");
	});
});

describe("importExtensionModules", () => {
	it("loads TypeScript extension sources through the runtime loader", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, { withDist: false });
		const [entry] = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});

		const modules = await importExtensionModules([entry]);
		expect(modules).toHaveLength(1);
		expect(modules[0]?.packageDir).toBe(pkgDir);
		expect(modules[0]?.module.manifest.id).toBe("x");
	});
});

describe("buildExtensionCatalog", () => {
	it("orders present optional dependencies before capability consumers", async () => {
		const token = createCapabilityToken<string>("test:optional-owner");
		const consumer = createLoadedExtensionModuleForTest({
			manifest: { id: "consumer", version: "1", optional: ["owner"] },
			setupCatalog(api) {
				expect(api.get(token)).toBe("available");
			},
		});
		const owner = createLoadedExtensionModuleForTest({
			manifest: { id: "owner", version: "1" },
			setupCatalog(api) {
				api.provide(token, "available");
			},
		});

		const catalog = await buildExtensionCatalog([consumer, owner]);

		expect(catalog.modules.map((loaded) => loaded.module.manifest.id)).toEqual([
			"owner",
			"consumer",
		]);
	});

	it("allows absent optional dependencies", async () => {
		const consumer = createLoadedExtensionModuleForTest({
			manifest: { id: "consumer", version: "1", optional: ["missing"] },
		});

		await expect(buildExtensionCatalog([consumer])).resolves.toMatchObject({
			modules: [consumer],
		});
	});

	it("rejects cycles through present optional dependencies", async () => {
		const first = createLoadedExtensionModuleForTest({
			manifest: { id: "first", version: "1", optional: ["second"] },
		});
		const second = createLoadedExtensionModuleForTest({
			manifest: { id: "second", version: "1", optional: ["first"] },
		});

		await expect(buildExtensionCatalog([first, second])).rejects.toThrow(
			"Circular extension dependency detected",
		);
	});

	it("assigns model providers and Pi resources to owners in dependency order", async () => {
		const provider = defineModelProvider({
			id: "provider-a",
			parseConfig: () => ({ config: {} }),
			worker: builtinPiProvider("openai"),
			models: () => [],
			secrets: () => ({}),
		});
		const dependent = createLoadedExtensionModuleForTest(
			{
				manifest: { id: "dependent", version: "1", requires: ["provider-owner"] },
			},
			{ packageName: "dependent-package" },
		);
		const owner = {
			...createLoadedExtensionModuleForTest(
				{
					manifest: { id: "provider-owner", version: "1" },
					modelProviders: defineModelProviders((rawConfig) => [
						{ definition: provider, rawConfig },
					]),
				},
				{ packageName: "owner-package" },
			),
			pi: {
				workerEntryPath: "/owner/pi-worker.ts",
				resources: { skillDirectories: ["/owner/skills"], promptDirectories: [] },
			},
		};
		const catalog = await buildExtensionCatalog([dependent, owner]);

		expect(catalog.modules.map((loaded) => loaded.module.manifest.id)).toEqual([
			"provider-owner",
			"dependent",
		]);
		expect(catalog.modelProviders).toHaveLength(1);
		expect(catalog.modelProviders[0]).toMatchObject({
			ownerExtensionId: "provider-owner",
			packageName: "owner-package",
		});
		expect(catalog.modelProviders[0]?.resolve({ endpoint: "test" })).toEqual([
			{ definition: provider, rawConfig: { endpoint: "test" } },
		]);
		expect(catalog.piContributions).toEqual([
			{
				ownerExtensionId: "provider-owner",
				packageName: "owner-package",
				workerEntryPath: "/owner/pi-worker.ts",
				resources: { skillDirectories: ["/owner/skills"], promptDirectories: [] },
			},
		]);
	});

	it("rejects processes that were not created with defineProcess", async () => {
		await expect(
			buildExtensionCatalog([
				createLoadedExtensionModuleForTest({
					manifest: { id: "manual-process-extension", version: "0.1.0" },
					setupCatalog(api) {
						api.registerProcess({
							id: "manual_process",
							displayName: "Manual",
							entryTurnId: "start",
							turns: new Map(),
							paramsCodec: { parse: () => ({}), serialize: (value) => value },
							stateCodec: { parse: () => ({}), serialize: (value) => value },
							initialState: () => ({}),
						});
					},
				}),
			]),
		).rejects.toThrow("Processes must be created with defineProcess(...)");
	});

	it("allows multiple graph-defined processes to reuse the same registered turn metadata", async () => {
		const emptyCodec = {
			parse: () => ({}),
			serialize: (value: Record<string, never>) => value,
		};
		const first = defineProcess({
			id: "first_process",
			displayName: "First",
			entry: "run_single_prompt",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				run_single_prompt: llmTurn({
					availableTools: [],
					description: "Run a shared prompt",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "prompt",
					turnEnd: { outcome: "completed", params: {}, complete: true },
				}),
			},
		});
		const second = defineProcess({
			id: "second_process",
			displayName: "Second",
			entry: "run_single_prompt",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				run_single_prompt: llmTurn({
					availableTools: [],
					description: "Run a shared prompt",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "another prompt body",
					turnEnd: { outcome: "completed", params: {}, complete: true },
				}),
			},
		});

		const catalog = await buildExtensionCatalog([
			createLoadedExtensionModuleForTest({
				manifest: { id: "shared-turn-extension", version: "0.1.0" },
				setupCatalog(api) {
					api.registerProcess(first);
					api.registerProcess(second);
				},
			}),
		]);

		expect(catalog.processes.get("first_process")?.turns.has("run_single_prompt")).toBe(true);
		expect(catalog.processes.get("second_process")?.turns.has("run_single_prompt")).toBe(true);
		expect(catalog.processes.size).toBe(2);
		expect("processDefinitions" in catalog).toBe(false);
		const firstProcess = catalog.processes.get("first_process");
		expect(firstProcess).toBeDefined();
		if (!firstProcess) {
			return;
		}
		const graph = toProcessGraphView(firstProcess);
		expect([...graph.entryTurnIds]).toEqual(["run_single_prompt"]);
		expect(graph.turns.get("run_single_prompt")?.turnType).toBe("llm");
	});

	it("rejects registered processes with graph transition targets outside the process", async () => {
		const emptyCodec = {
			parse: () => ({}),
			serialize: (value: Record<string, never>) => value,
		};
		const process = defineProcess({
			id: "invalid_graph_process",
			displayName: "Invalid Graph",
			entry: "start",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				start: llmTurn({
					availableTools: [],
					description: "Start",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "prompt",
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const start = process.turns.get("start");
		if (!start) {
			throw new Error("test process did not compile start turn");
		}
		setProcessTurnTransitions(start, [{ nextTurnId: "missing", outcome: "done" }]);

		await expect(
			buildExtensionCatalog([
				createLoadedExtensionModuleForTest({
					manifest: { id: "invalid-graph-extension", version: "0.1.0" },
					setupCatalog(api) {
						api.registerProcess(process);
					},
				}),
			]),
		).rejects.toThrow(/invalid_graph_process.*undeclared nextTurnId 'missing'/);
	});

	it("rejects registered processes that consume products never published by the process", async () => {
		const emptyCodec = {
			parse: () => ({}),
			serialize: (value: Record<string, never>) => value,
		};
		const process = defineProcess({
			id: "invalid_product_process",
			displayName: "Invalid Product",
			entry: "consume_plan",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				consume_plan: llmTurn({
					availableTools: [],
					description: "Consume plan",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "prompt",
					consumedProducts: ["plan"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});

		await expect(
			buildExtensionCatalog([
				createLoadedExtensionModuleForTest({
					manifest: { id: "invalid-product-extension", version: "0.1.0" },
					setupCatalog(api) {
						api.registerProcess(process);
					},
				}),
			]),
		).rejects.toThrow(/invalid_product_process.*consumes product 'plan' that is never published/);
	});

	it("rejects registered processes with graph transitions that do not declare exactly one target", async () => {
		const emptyCodec = {
			parse: () => ({}),
			serialize: (value: Record<string, never>) => value,
		};
		const process = defineProcess({
			id: "ambiguous_graph_process",
			displayName: "Ambiguous Graph",
			entry: "start",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				start: llmTurn({
					availableTools: [],
					description: "Start",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "prompt",
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});
		const start = process.turns.get("start");
		if (!start) {
			throw new Error("test process did not compile start turn");
		}
		setProcessTurnTransitions(start, [{ outcome: "done" }]);

		await expect(
			buildExtensionCatalog([
				createLoadedExtensionModuleForTest({
					manifest: { id: "ambiguous-graph-extension", version: "0.1.0" },
					setupCatalog(api) {
						api.registerProcess(process);
					},
				}),
			]),
		).rejects.toThrow(/ambiguous_graph_process.*exactly one target/);
	});

	it("allows process-scoped turn ids even when their metadata diverges", async () => {
		const emptyCodec = {
			parse: () => ({}),
			serialize: (value: Record<string, never>) => value,
		};
		const first = defineProcess({
			id: "first_process",
			displayName: "First",
			entry: "shared_turn",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				shared_turn: llmTurn({
					availableTools: [],
					description: "Shared",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "prompt",
					turnEnd: { outcome: "completed", params: {}, complete: true },
				}),
			},
		});
		const second = defineProcess({
			id: "second_process",
			displayName: "Second",
			entry: "shared_turn",
			paramsCodec: emptyCodec,
			stateCodec: emptyCodec,
			initialState: () => ({}),
			turns: {
				shared_turn: llmTurn({
					availableTools: [],
					description: "Different description",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "prompt",
					turnEnd: { outcome: "completed", params: {}, complete: true },
				}),
				decision: humanTurn({
					description: "Decision",
					reviewSubject: { kind: "plan" },
					actions: {
						approve: {
							label: "Approve",
							acceptanceState: "accepted",
							complete: true,
						},
					},
				}),
			},
		});

		const catalog = await buildExtensionCatalog([
			createLoadedExtensionModuleForTest({
				manifest: { id: "conflicting-turn-extension", version: "0.1.0" },
				setupCatalog(api) {
					api.registerProcess(first);
					api.registerProcess(second);
				},
			}),
		]);

		expect(
			catalog.processes.get("first_process")?.turns.get("shared_turn")?.definition.description,
		).toBe("Shared");
		expect(
			catalog.processes.get("second_process")?.turns.get("shared_turn")?.definition.description,
		).toBe("Different description");
	});
});
