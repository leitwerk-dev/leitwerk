import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { type Codec, defineProcess, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import type { AppContext } from "@leitwerk-dev/server";
import { postImmediateLaunchRequest } from "@leitwerk-dev/test-support";
import { createIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let ctx: AppContext;
let address: string;

const retryConfigEntryTurn = {
	id: "retry_config_entry",
	description: "Retry config entry turn",
	availableTools: [],
	kind: "llm" as const,
	completionMode: "turn_end" as const,
	branchType: "primary" as const,
	context: "fresh" as const,
	prompt: async () => "Retry config test",
	outcomes: {},
	turnEnd: { outcome: "completed" as const, params: {}, complete: true },
};

const retryConfigParamsCodec: Codec<Record<string, unknown>> = {
	parse(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	},
	serialize(value) {
		return value;
	},
};

const retryConfigStateCodec: Codec<Record<string, never>> = {
	parse() {
		return {};
	},
	serialize(value) {
		return value;
	},
};

const retryConfigTestProcess = defineProcess<Record<string, unknown>, Record<string, never>>({
	id: "retry_config_test_process",
	displayName: "Retry Config Test Process",
	entry: "retry_config_entry",
	turns: { retry_config_entry: retryConfigEntryTurn },
	paramsCodec: retryConfigParamsCodec,
	stateCodec: retryConfigStateCodec,
	initialState() {
		return {};
	},
	worker(api) {
		api.start("retry_config_entry");
	},
	launchers(api) {
		for (const launcherId of [
			"retry_config_test_process.primary_ui",
			"retry_config_test_process.secondary_ui",
		]) {
			api.launcher({
				id: launcherId,
				label: launcherId.endsWith("primary_ui") ? "Primary UI" : "Secondary UI",
				description: "Retry-config test launcher",
				visibility: "ui",
				ui: {
					card: {},
					launchConfigSchema: {
						id: launcherId.replace(/\./g, "-"),
						title: launcherId,
						fields: [
							{ id: "repoPath", label: "Repo Path", kind: "text", required: true },
							{ id: "branch", label: "Branch", kind: "text" },
						],
						submitLabel: "Launch",
					},
					resolveRelaunchInput(input) {
						return launcherId.endsWith("secondary_ui") ? { ...input, branch: "" } : input;
					},
					resolveLaunchConfig(input) {
						return {
							ok: true,
							launchConfig: {
								processId: "retry_config_test_process",
								params: {
									repoPath: typeof input.repoPath === "string" ? input.repoPath : "",
									branch: typeof input.branch === "string" ? input.branch : "main",
								},
							},
						};
					},
				},
			});
		}
	},
});

const noLauncherProcess = defineProcess<Record<string, unknown>, Record<string, never>>({
	id: "no_launcher_process",
	displayName: "No Launcher Process",
	entry: "retry_config_entry",
	turns: { retry_config_entry: retryConfigEntryTurn },
	paramsCodec: retryConfigParamsCodec,
	stateCodec: retryConfigStateCodec,
	initialState() {
		return {};
	},
	worker(api) {
		api.start("retry_config_entry");
	},
});

const retryConfigTestExtension: LeitwerkExtensionModule = {
	manifest: { id: "retry-config-http-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(retryConfigTestProcess);
		api.registerProcess(noLauncherProcess);
	},
};

const testExtensionCatalog = buildExtensionCatalogFromModules([retryConfigTestExtension]);

beforeAll(async () => {
	const harness = await createIntegrationHarness({
		extensionCatalog: testExtensionCatalog,
	});
	ctx = harness.ctx;
	address = harness.address;
});

afterAll(async () => {
	await ctx.app.close();
});

describe("GET /api/processes/:instanceId/retry-config", () => {
	it("returns 404 when process not found", async () => {
		const res = await fetch(`${address}/api/processes/nonexistent-id/retry-config`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Process not found");
	});

	it("returns 404 when no UI-visible launcher exists for process type", async () => {
		const process = ctx.deps.processes.create({
			processId: "no_launcher_process",
			selectedTurnId: "retry_config_entry",
			lifecycleStatus: "active",
			externalId: "TEST-123",
			paramsJson: JSON.stringify({ issueKey: "TEST-123" }),
		});

		const res = await fetch(`${address}/api/processes/${process.id}/retry-config`);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("No launcher found for this process type");
	});

	it("returns the original UI launcher from process metadata and preserves retry inputs", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([retryConfigTestExtension]),
		});
		try {
			const process = harness.ctx.deps.processes.create({
				processId: "retry_config_test_process",
				selectedTurnId: "retry_config_entry",
				lifecycleStatus: "active",
				metadata: {
					launcherId: "retry_config_test_process.secondary_ui",
				},
				paramsJson: JSON.stringify({
					repoPath: "/tmp/retry-target",
					branch: "release/test",
					note: "preserve me",
				}),
				defaultModelProfileId: "model-default",
				turnConfigsJson: JSON.stringify({
					retry_config_entry: { modelProfileId: "model-turn" },
				}),
			});

			harness.ctx.deps.processes.update(process.id, { title: "Retry Title" });

			const res = await fetch(`${harness.address}/api/processes/${process.id}/retry-config`);
			expect(res.status).toBe(200);

			const body = await res.json();
			expect(body).toEqual({
				launcherId: "retry_config_test_process.secondary_ui",
				title: "Retry Title",
				launcherInput: {
					repoPath: "/tmp/retry-target",
					branch: "",
					note: "preserve me",
				},
				skillIds: [],
				modelConfig: {
					defaultModelProfileId: "model-default",
					turnConfigs: {
						retry_config_entry: { modelProfileId: "model-turn" },
					},
				},
			});
		} finally {
			await harness.ctx.app.close();
		}
	});

	it("uses persisted operator input instead of mutated process params", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([retryConfigTestExtension]),
		});
		try {
			harness.ctx.deps.skills.reconcile([
				{
					skillId: "review-draft",
					label: "Review draft",
					description: null,
					bundle: createCanonicalPiResourceBundle([
						{
							path: "skills/review-draft/SKILL.md",
							content: Buffer.from("# Review draft"),
						},
					]),
					sourceRevision: null,
				},
			]);
			const launched = await postImmediateLaunchRequest(
				`${harness.address}/api/launchers/retry_config_test_process.primary_ui/launch-runs`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: { repoPath: "/original/repo", branch: "feature/original" },
						skillIds: ["review-draft"],
					}),
				},
			);
			expect(launched.status).toBe(201);
			const launchBody = (await launched.json()) as { process: { id: string } };
			harness.ctx.deps.processes.update(launchBody.process.id, {
				paramsJson: JSON.stringify({ repoPath: "/mutated/runtime", branch: "dirty-runtime" }),
			});

			const res = await fetch(
				`${harness.address}/api/processes/${launchBody.process.id}/retry-config`,
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				launcherInput: { repoPath: "/original/repo", branch: "feature/original" },
				skillIds: ["review-draft"],
			});
		} finally {
			await harness.ctx.app.close();
		}
	});

	it("falls back to empty launcher input when stored paramsJson is invalid", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([retryConfigTestExtension]),
		});
		try {
			const process = harness.ctx.deps.processes.create({
				processId: "retry_config_test_process",
				selectedTurnId: "retry_config_entry",
				lifecycleStatus: "active",
				metadata: {
					launcherId: "retry_config_test_process.primary_ui",
				},
				paramsJson: "[1,2,3]",
			});

			const res = await fetch(`${harness.address}/api/processes/${process.id}/retry-config`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				launcherId: "retry_config_test_process.primary_ui",
				title: null,
				launcherInput: {},
				skillIds: [],
				modelConfig: {},
			});
		} finally {
			await harness.ctx.app.close();
		}
	});
});
