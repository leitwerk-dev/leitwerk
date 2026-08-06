import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessInstance } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { describe, expect, it } from "vitest";
import showcaseProcessesExtension from "./index.js";

const filesystemWatcherFixtureProviderExtension = {
	manifest: { id: "filesystem-watcher-fixture-provider", version: "1.0.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "filesystem-watcher-fixture-provider",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("filesystem-watcher-fixture-provider"),
				server: builtinPiProvider("filesystem-watcher-fixture-provider"),
				models: () => [{ modelId: "fixture-model", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};

const extensionCatalog = buildExtensionCatalogFromModules([
	showcaseProcessesExtension,
	filesystemWatcherFixtureProviderExtension,
]);

async function waitFor<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for filesystem watcher condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function listPoemProcesses(harness: IntegrationHarness<Record<string, never>>): ProcessInstance[] {
	return harness.ctx.deps.processes
		.listAll()
		.filter((process) => process.processId === "poem_creator_process");
}

async function createFilesystemWatcherHarness(args: {
	filePath: string;
	inProcessWorkers?: boolean;
	localWorkerSpawnImpl?: typeof spawn;
}) {
	const harness = await createIntegrationHarness({
		extensionCatalog,
		inProcessWorkers: args.inProcessWorkers,
		...(args.localWorkerSpawnImpl
			? { appOverrides: { localWorkerSpawnImpl: args.localWorkerSpawnImpl } }
			: {}),
		configOverride(config) {
			config.process_configs = {
				poem_creator_process: {
					default_model_profile: "filesystem-watcher-model",
					turn_configs: {},
					watchers: {
						create_poem: {
							type: "filesystem",
							enabled: true,
							poll_interval: "50ms",
							file_path: args.filePath,
						},
					},
				},
			};
			config.pi.model_profiles = [
				{
					id: "filesystem-watcher-model",
					provider: "filesystem-watcher-fixture-provider",
					model_id: "fixture-model",
				},
			];
		},
	});
	await harness.ctx.startBackgroundServices();
	return harness;
}

describe("showcase filesystem watcher", () => {
	it("launches a poem creator process from the watched file contents and consumes the file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-showcase-filesystem-watcher-"));
		const filePath = path.join(dir, "create-poem");
		const prompt = "\n  Write a short poem about rain over Berlin.  \n";
		await writeFile(filePath, prompt, "utf8");

		let harness: IntegrationHarness<Record<string, never>> | null = null;
		try {
			harness = await createFilesystemWatcherHarness({
				filePath,
				inProcessWorkers: true,
			});

			const process = await waitFor(
				() => listPoemProcesses(harness)[0] ?? null,
				(candidate) =>
					candidate !== null &&
					candidate.lifecycleStatus === "waiting" &&
					candidate.selectedTurnId === "poem_review",
			);

			expect(JSON.parse(process.paramsJson ?? "{}")).toEqual({
				prompt: "Write a short poem about rain over Berlin.",
			});
			expect(listPoemProcesses(harness)).toHaveLength(1);
			await waitFor(
				() => existsSync(filePath),
				(exists) => exists === false,
			);
		} finally {
			await harness?.ctx.app.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("consumes the trigger file after durable creation even if immediate worker startup fails", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-showcase-filesystem-watcher-"));
		const filePath = path.join(dir, "create-poem");
		await writeFile(filePath, "Write a short poem about launch retries.", "utf8");

		const failingSpawn = (() => {
			throw new Error("spawn failed intentionally");
		}) as typeof spawn;

		let harness: IntegrationHarness<Record<string, never>> | null = null;
		try {
			harness = await createFilesystemWatcherHarness({
				filePath,
				inProcessWorkers: false,
				localWorkerSpawnImpl: failingSpawn,
			});

			const createdProcess = await waitFor(
				() => listPoemProcesses(harness)[0] ?? null,
				(candidate) => candidate !== null,
			);
			await waitFor(
				() => existsSync(filePath),
				(exists) => exists === false,
			);
			await new Promise((resolve) => setTimeout(resolve, 250));

			expect(listPoemProcesses(harness).map((process) => process.id)).toEqual([createdProcess.id]);
			expect(JSON.parse(createdProcess.paramsJson ?? "{}")).toEqual({
				prompt: "Write a short poem about launch retries.",
			});
		} finally {
			await harness?.ctx.app.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
