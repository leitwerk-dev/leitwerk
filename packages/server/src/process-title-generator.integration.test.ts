import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForValue as waitFor } from "@leitwerk-dev/test-support/integration";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import {
	createProcessTitleGenerator,
	type ProcessTitleGeneratorRuntimeDeps,
} from "./process-title-generator.js";
import { createProcessTitleLaunchPlan as createLaunchPlan } from "./test-helpers/process-title-fixtures.js";
import { createTestDeps, type TestDeps } from "./test-helpers/unit-deps.js";

type RuntimeOutcome = { kind: "throw"; error: Error } | { kind: "return"; title: string };

const tempDirs: string[] = [];

async function createTempRoot(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "leitwerk-title-provider-extension-"));
	tempDirs.push(dir);
	return dir;
}

async function writePiExtension(agentDir: string, source: string): Promise<void> {
	const extensionDir = path.join(agentDir, "extensions", "test-provider");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(path.join(extensionDir, "index.ts"), source);
}

function providerExtensionSource(observationFile: string): string {
	return `
import { appendFileSync } from "node:fs";

export default function providerExtension(pi) {
  pi.registerProvider("extension-provider", {
    name: "Extension Provider",
    baseUrl: "https://example.invalid/v1",
    apiKey: "fallback-key",
    api: "title-test",
    streamSimple(model, context, options) {
      appendFileSync(${JSON.stringify(observationFile)}, JSON.stringify({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        tools: context.tools,
        modelMaxTokens: model.maxTokens,
        reasoning: options?.reasoning,
        sessionId: options?.sessionId,
        apiKey: options?.apiKey,
        env: options?.env,
      }) + "\\n");
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Extension backed title" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
        async result() { return message; },
      };
    },
    models: [
      {
        id: "extension-model",
        name: "Extension Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    ],
  });
}
`;
}

function attachFrameRecorder(deps: TestDeps) {
	const frames: Array<{ type: string; instanceId?: string; payload: unknown }> = [];
	deps.broadcaster.addClient({
		readyState: 1,
		send(data: string) {
			frames.push(JSON.parse(data) as { type: string; instanceId?: string; payload: unknown });
		},
		on() {},
	});
	return frames;
}

function createGeneratorHarness(options: {
	deps?: TestDeps;
	outcomes: RuntimeOutcome[];
	retryBaseDelayMs?: number;
	pollIntervalMs?: number;
}) {
	const deps = options.deps ?? createTestDeps();
	const config = getDefaultConfig();
	config.pi.model_profiles = [
		{ id: "claude_fast", provider: "anthropic", model_id: "claude-test" },
	];
	config.pi.process_title_generation.model_profile = "claude_fast";
	config.pi.process_title_generation.retry = {
		max_attempts: 6,
		base_delay: `${options.retryBaseDelayMs ?? 10}ms`,
		max_delay: `${options.retryBaseDelayMs ?? 10}ms`,
	};
	let callCount = 0;

	const runtime = {
		async generateTitle() {
			const outcome = options.outcomes[Math.min(callCount, options.outcomes.length - 1)];
			callCount += 1;
			if (!outcome || outcome.kind === "throw") {
				throw outcome?.error ?? new Error("unexpected title-generation test call");
			}
			return outcome.title;
		},
		pollIntervalMs: options.pollIntervalMs ?? 5,
	} satisfies Partial<ProcessTitleGeneratorRuntimeDeps>;

	const generator = createProcessTitleGenerator({
		config,
		repos: deps,
		broadcaster: deps.broadcaster,
		runtime,
	});

	return {
		deps,
		generator,
		getCallCount() {
			return callCount;
		},
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("process title generator retries", () => {
	it("runs isolated cheap sessions through the managed provider runtime", async () => {
		const root = await createTempRoot();
		const agentDir = path.join(root, "agent");
		const observationFile = path.join(root, "title-requests.jsonl");
		await writePiExtension(agentDir, providerExtensionSource(observationFile));
		await writeFile(
			path.join(agentDir, "auth.json"),
			JSON.stringify({
				"extension-provider": {
					type: "api_key",
					key: "stored-key",
					env: { TITLE_ENV: "managed" },
				},
			}),
		);

		const deps = createTestDeps();
		const config = getDefaultConfig();
		config.pi.agent_dir = agentDir;
		config.pi.process_title_generation.model_profile = "extension-profile";
		config.pi.model_profiles = [
			{
				id: "extension-profile",
				provider: "extension-provider",
				model_id: "extension-model",
			},
		];
		const generator = createProcessTitleGenerator({
			config,
			repos: deps,
			broadcaster: deps.broadcaster,
		});
		const firstProcess = deps.processes.create(createLaunchPlan().processInput);
		const secondProcess = deps.processes.create(createLaunchPlan().processInput);

		try {
			generator.queueProcessTitleGeneration?.({
				processId: firstProcess.id,
				launchPlan: createLaunchPlan(),
			});
			generator.queueProcessTitleGeneration?.({
				processId: secondProcess.id,
				launchPlan: createLaunchPlan(),
			});

			await waitFor(
				() => [
					deps.processes.getById(firstProcess.id)?.title,
					deps.processes.getById(secondProcess.id)?.title,
				],
				(titles) => titles.every((title) => title === "Extension backed title"),
			);

			const observations = (await readFile(observationFile, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(observations).toHaveLength(2);
			for (const observation of observations) {
				expect(observation.systemPrompt).toContain(
					"You write concise operator-facing titles for process instances.",
				);
				expect(observation.systemPrompt).not.toContain("expert coding assistant");
				expect(observation.messages).toEqual([expect.objectContaining({ role: "user" })]);
				expect(observation.tools).toEqual([]);
				expect(observation.modelMaxTokens).toBe(48);
				expect(observation).not.toHaveProperty("reasoning");
				expect(observation.apiKey).toBe("stored-key");
				expect(observation.env).toEqual({ TITLE_ENV: "managed" });
			}
			expect(observations[0]?.sessionId).not.toBe(observations[1]?.sessionId);
		} finally {
			await generator.close?.();
		}
	});

	it("retries a failed process title request and broadcasts the eventual title update", async () => {
		const harness = createGeneratorHarness({
			outcomes: [
				{ kind: "throw", error: new Error("temporary timeout") },
				{ kind: "return", title: "Recovered title" },
			],
		});
		const frames = attachFrameRecorder(harness.deps);
		const process = harness.deps.processes.create(createLaunchPlan().processInput);

		try {
			harness.generator.queueProcessTitleGeneration?.({
				processId: process.id,
				launchPlan: createLaunchPlan(),
			});

			await waitFor(
				() => harness.deps.processes.getById(process.id)?.title,
				(value) => value === "Recovered title",
			);

			expect(harness.getCallCount()).toBe(2);
			expect(
				harness.deps.titleJobs.listAll().filter((job) => job.processInstanceId === process.id),
			).toEqual([expect.objectContaining({ status: "completed", attemptCount: 2 })]);
			expect(
				frames.some((frame) => {
					if (frame.type !== "process.updated" || frame.instanceId !== process.id) {
						return false;
					}
					const payload = frame.payload as { process?: { title?: string | null } };
					return payload.process?.title === "Recovered title";
				}),
			).toBe(true);
		} finally {
			await harness.generator.close?.();
		}
	});

	it("does not overwrite a manual title added before the retry runs", async () => {
		const harness = createGeneratorHarness({
			outcomes: [
				{ kind: "throw", error: new Error("temporary timeout") },
				{ kind: "return", title: "Generated retry title" },
			],
			retryBaseDelayMs: 40,
		});
		const process = harness.deps.processes.create(createLaunchPlan().processInput);

		try {
			harness.generator.queueProcessTitleGeneration?.({
				processId: process.id,
				launchPlan: createLaunchPlan(),
			});

			await waitFor(
				() =>
					harness.deps.titleJobs.listAll().filter((job) => job.processInstanceId === process.id)[0],
				(job) => job?.status === "pending" && job.attemptCount === 1,
			);
			harness.deps.processes.update(process.id, { title: "Manual title" });

			await waitFor(
				() =>
					harness.deps.titleJobs.listAll().filter((job) => job.processInstanceId === process.id)[0],
				(job) => job?.status === "superseded",
			);

			expect(harness.deps.processes.getById(process.id)?.title).toBe("Manual title");
			expect(harness.getCallCount()).toBe(1);
		} finally {
			await harness.generator.close?.();
		}
	});

	it("retries persisted pending title jobs after the service restarts", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create(createLaunchPlan().processInput);
		const firstHarness = createGeneratorHarness({
			deps,
			outcomes: [{ kind: "throw", error: new Error("temporary timeout") }],
			retryBaseDelayMs: 25,
		});

		firstHarness.generator.queueProcessTitleGeneration?.({
			processId: process.id,
			launchPlan: createLaunchPlan(),
		});
		await waitFor(
			() => deps.titleJobs.listAll().filter((job) => job.processInstanceId === process.id)[0],
			(job) => job?.status === "pending" && job.attemptCount === 1,
		);
		await firstHarness.generator.close?.();
		expect(firstHarness.getCallCount()).toBe(1);

		const secondHarness = createGeneratorHarness({
			deps,
			outcomes: [{ kind: "return", title: "Recovered after restart" }],
			retryBaseDelayMs: 25,
		});

		try {
			await secondHarness.generator.start?.();
			await waitFor(
				() => deps.processes.getById(process.id)?.title,
				(value) => value === "Recovered after restart",
				15_000,
			);

			expect(secondHarness.getCallCount()).toBe(1);
			expect(
				deps.titleJobs.listAll().filter((job) => job.processInstanceId === process.id),
			).toEqual([expect.objectContaining({ status: "completed", attemptCount: 2 })]);
		} finally {
			await secondHarness.generator.close?.();
		}
	});
});
