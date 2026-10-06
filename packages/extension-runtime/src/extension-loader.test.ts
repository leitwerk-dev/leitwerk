import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	builtinPiProvider,
	createCapabilityToken,
	type DefinedProcessInput,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	type ExtensionProcessDefinition,
	emptyParamsCodec,
	humanTurn,
	type LlmTurnDefinition,
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
const runtimeLanes = [
	{ lane: "source", directory: "src", extension: "ts" },
	{ lane: "dist", directory: "dist", extension: "js" },
];

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
		skillsMetadata?: unknown;
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
				...(opts.skillsMetadata === undefined ? {} : { skills: opts.skillsMetadata }),
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
	it.each([
		"source",
		"dist",
	])("discovers the same generated skill pack in the %s lane", async (lane) => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = lane;
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, {
			withDist: true,
			skillsMetadata: "./dist/skills/manifest.json",
		});
		const entries = await resolveExtensionEntries({ startDir: root, sources: [pkgDir] });
		expect(entries[0].skillPackPath).toBe(path.join(pkgDir, "dist/skills/manifest.json"));
		const loaded = await importExtensionModules(entries);
		expect(loaded[0].skillPackPath).toBe(entries[0].skillPackPath);
	});

	it("rejects skill-pack metadata outside the package", async () => {
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, {
			withDist: true,
			skillsMetadata: "../outside.json",
		});
		await expect(resolveExtensionEntries({ startDir: root, sources: [pkgDir] })).rejects.toThrow();
	});

	it("returns an empty entry list when no extension sources are configured", async () => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = "source";
		const root = await createWorkspace();
		await createExtensionPackage(root, { withDist: false });

		await expect(resolveExtensionEntries({ startDir: root, sources: [] })).resolves.toEqual([]);
	});

	it.each(runtimeLanes)("resolves configured package directories in the $lane lane", async ({
		lane,
		directory,
		extension,
	}) => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = lane;
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, { withDist: lane === "dist" });
		const entries = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});
		expect(entries).toEqual([
			{
				packageName: "@example/example",
				packageDir: pkgDir,
				entryPath: path.join(pkgDir, directory, `index.${extension}`),
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

	it.each(runtimeLanes)("resolves Pi entries and resources in the $lane lane", async ({
		lane,
		directory,
		extension,
	}) => {
		process.env[LEITWERK_RUNTIME_LANE_ENV] = lane;
		const root = await createWorkspace();
		const pkgDir = await createExtensionPackage(root, {
			withDist: lane === "dist",
			piMetadata: {
				worker: { source: "./src/pi-worker.ts", import: "./dist/pi-worker.js" },
				server: { source: "./src/pi-server.ts", import: "./dist/pi-server.js" },
				resources: lane === "source" ? { skills: ["./skills"], prompts: ["./prompts"] } : undefined,
			},
		});
		if (lane === "source") {
			await mkdir(path.join(pkgDir, "skills"));
			await mkdir(path.join(pkgDir, "prompts"));
		}
		const [entry] = await resolveExtensionEntries({
			startDir: root,
			sources: ["./extensions/example"],
		});
		expect(entry.pi).toEqual({
			workerEntryPath: path.join(pkgDir, directory, `pi-worker.${extension}`),
			serverEntryPath: path.join(pkgDir, directory, `pi-server.${extension}`),
			resources: {
				skillDirectories: lane === "source" ? [path.join(pkgDir, "skills")] : [],
				promptDirectories: lane === "source" ? [path.join(pkgDir, "prompts")] : [],
			},
		});
	});

	it("rejects a Pi worker entry outside its owning package", async () => {
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
	type TestProcessInput = DefinedProcessInput<Record<string, never>, Record<string, never>>;

	function testLlmTurn(
		description: string,
		overrides: Partial<
			LlmTurnDefinition<string, Record<string, never>, Record<string, never>>
		> = {},
	) {
		return llmTurn({
			availableTools: [],
			description,
			branchType: "primary",
			context: "fresh",
			prompt: async () => "prompt",
			turnEnd: { outcome: "done", params: {}, complete: true },
			...overrides,
		});
	}

	function defineTestProcess(
		input: Pick<TestProcessInput, "id" | "turns"> & Partial<TestProcessInput>,
	) {
		return defineProcess({
			displayName: input.id,
			entry: Object.keys(input.turns)[0],
			paramsCodec: emptyParamsCodec,
			stateCodec: emptyParamsCodec,
			initialState: () => ({}),
			...input,
		});
	}

	function catalogWithProcesses(
		...processes: ExtensionProcessDefinition<Record<string, never>, Record<string, never>>[]
	) {
		return buildExtensionCatalog([
			createLoadedExtensionModuleForTest({
				manifest: { id: "process-extension", version: "0.1.0" },
				setupCatalog(api) {
					for (const process of processes) api.registerProcess(process);
				},
			}),
		]);
	}

	it("orders present optional dependencies before capability consumers", async () => {
		const token = createCapabilityToken<string>("test:optional-owner");
		const observed: unknown[] = [];
		const consumer = createLoadedExtensionModuleForTest({
			manifest: { id: "consumer", version: "1", optional: ["owner", "owner"] },
			setupCatalog(api) {
				const { get, require: requireCapability } = api;
				observed.push(get(token), requireCapability(token));
			},
		});
		const owner = createLoadedExtensionModuleForTest({
			manifest: { id: "owner", version: "1" },
			setupCatalog(api) {
				api.provide(token, "available");
			},
		});

		const catalog = await buildExtensionCatalog([consumer, owner]);
		expect(observed).toEqual(["available", "available"]);
		const { get, require: requireCapability } = catalog;
		expect(get(token)).toBe("available");
		expect(requireCapability(token)).toBe("available");

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

	it("rejects registered processes with graph transition targets outside the process", async () => {
		const process = defineTestProcess({
			id: "invalid_graph_process",
			turns: {
				start: testLlmTurn("Start"),
			},
		});
		const start = process.turns.get("start");
		if (!start) {
			throw new Error("test process did not compile start turn");
		}
		setProcessTurnTransitions(start, [{ nextTurnId: "missing", outcome: "done" }]);

		await expect(catalogWithProcesses(process)).rejects.toThrow(
			/invalid_graph_process.*undeclared nextTurnId 'missing'/,
		);
	});

	it.each([
		"declaration",
		"retained",
	] as const)("rechecks %s routing changes against the happy path", async (source) => {
		const process = defineTestProcess({
			id: "disconnected_process",
			happyPath: ["start", "done"],
			turns: {
				start: testLlmTurn("Start", {
					turnEnd: { outcome: "ready", params: {}, to: "done" },
				}),
				done: humanTurn({
					description: "Done",
					actions: {
						finish: { label: "Finish", acceptanceState: "accepted", complete: true },
					},
				}),
			},
		});
		const start = process.turns.get("start");
		if (start?.definition.kind !== "llm") throw new Error("test start turn is missing");
		if (source === "declaration") {
			start.definition.turnEnd = { outcome: "ready", params: {}, complete: true };
		} else {
			setProcessTurnTransitions(start, [{ outcome: "ready", lifecycleStatus: "completed" }]);
		}

		await expect(catalogWithProcesses(process)).rejects.toThrow(
			/disconnected_process.*happy path segment 'start' -> 'done' is not connected/,
		);
	});

	it("rechecks product declarations changed after definition", async () => {
		const process = defineTestProcess({
			id: "invalid_product_process",
			turns: {
				consume_plan: testLlmTurn("Consume plan"),
			},
		});
		const consumer = process.turns.get("consume_plan")?.definition;
		if (consumer?.kind !== "llm") throw new Error("test consumer is missing");
		consumer.consumedProducts = ["plan"];

		await expect(catalogWithProcesses(process)).rejects.toThrow(
			/invalid_product_process.*consumes product 'plan' that is never published/,
		);
	});

	it("rejects registered processes with graph transitions that do not declare exactly one target", async () => {
		const process = defineTestProcess({
			id: "ambiguous_graph_process",
			turns: {
				start: testLlmTurn("Start"),
			},
		});
		const start = process.turns.get("start");
		if (!start) {
			throw new Error("test process did not compile start turn");
		}
		setProcessTurnTransitions(start, [{ outcome: "done" }]);

		await expect(catalogWithProcesses(process)).rejects.toThrow(
			/ambiguous_graph_process.*exactly one target/,
		);
	});

	it("allows process-scoped turn ids even when their metadata diverges", async () => {
		const first = defineTestProcess({
			id: "first_process",
			turns: {
				shared_turn: testLlmTurn("Shared", {
					turnEnd: { outcome: "completed", params: {}, complete: true },
				}),
			},
		});
		const second = defineTestProcess({
			id: "second_process",
			turns: {
				shared_turn: testLlmTurn("Different description", {
					prompt: async () => "another prompt body",
					turnEnd: { outcome: "completed", params: {}, complete: true },
				}),
				decision: humanTurn({
					description: "Decision",
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

		const catalog = await catalogWithProcesses(first, second);

		expect(catalog.processes.size).toBe(2);
		for (const [process, description, prompt] of [
			[first, "Shared", "prompt"],
			[second, "Different description", "another prompt body"],
		] as const) {
			const registered = catalog.processes.get(process.id);
			if (!registered) throw new Error(`Missing process '${process.id}'`);
			expect([...registered.turns.keys()]).toEqual([...process.turns.keys()]);
			const turn = registered.turns.get("shared_turn")?.definition;
			if (turn?.kind !== "llm") throw new Error("Missing shared turn");
			expect(turn.description).toBe(description);
			expect(await turn.prompt({} as never)).toBe(prompt);
			const graph = toProcessGraphView(registered);
			expect([...graph.entryTurnIds]).toEqual(["shared_turn"]);
			expect(graph.turns.get("shared_turn")?.turnType).toBe("llm");
		}
	});
});
