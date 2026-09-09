import { defineProcess, type ExtensionProcessDefinition, llmTurn } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessLauncherRegistry } from "./process-launcher-registry.js";

interface TestParams {
	repoPath: string;
	ticketIssueKey?: string;
}

interface TestState {
	initializedFrom: string;
}

function makeProcess(
	overrides: Partial<ExtensionProcessDefinition<TestParams, TestState>> = {},
): ExtensionProcessDefinition<TestParams, TestState> {
	return defineProcess<TestParams, TestState>({
		id: overrides.id ?? "test_process",
		displayName: overrides.displayName ?? "Test Process",
		entry: "test_turn",
		paramsCodec: overrides.paramsCodec ?? {
			parse: (value: unknown) => {
				const candidate = typeof value === "object" && value !== null ? value : {};
				return {
					repoPath:
						typeof (candidate as { repoPath?: unknown }).repoPath === "string"
							? (candidate as { repoPath: string }).repoPath
							: "",
					ticketIssueKey:
						typeof (candidate as { ticketIssueKey?: unknown }).ticketIssueKey === "string"
							? (candidate as { ticketIssueKey: string }).ticketIssueKey
							: undefined,
				};
			},
			serialize: (value: TestParams) => value,
		},
		stateCodec: overrides.stateCodec ?? {
			parse: (value: unknown) => {
				const candidate = typeof value === "object" && value !== null ? value : {};
				return {
					initializedFrom:
						typeof (candidate as { initializedFrom?: unknown }).initializedFrom === "string"
							? (candidate as { initializedFrom: string }).initializedFrom
							: "",
				};
			},
			serialize: (value: TestState) => value,
		},
		initialState: overrides.initialState ?? ((params) => ({ initializedFrom: params.repoPath })),
		turns: {
			test_turn: llmTurn({
				availableTools: [],
				description: "Test turn",
				branchType: "primary",
				context: "fresh",
				prompt: async () => "test",
				turnEnd: { outcome: "done", params: {}, complete: true },
			}),
		},
		launchers: overrides.launchers,
	});
}

function buildRegistry(
	processes: Array<ExtensionProcessDefinition<TestParams, TestState>>,
	options?: Parameters<typeof buildProcessLauncherRegistry>[1],
) {
	return buildProcessLauncherRegistry(
		{
			processes: new Map(processes.map((process) => [process.id, process])),
		},
		options,
	);
}

describe("buildProcessLauncherRegistry", () => {
	it("lists UI launchers and resolves defaults/options", async () => {
		const registry = buildRegistry([
			makeProcess({
				launchers(api) {
					api.launcher({
						id: "local_repo_ui",
						label: "Local Repo",
						description: "Run against a local repository",
						visibility: "ui",
						ui: {
							card: {},
							launchConfigSchema: {
								id: "local_repo_form",
								title: "Local Repo",
								fields: [{ id: "repoPath", label: "Repo", kind: "text", required: true }],
								submitLabel: "Launch",
							},
							resolveDefaults() {
								return { repoPath: "/tmp/project" };
							},
							resolveOptions(input) {
								return {
									repoPath: [
										{
											value: typeof input.repoPath === "string" ? input.repoPath : "/tmp/project",
											label: "Suggested repo",
										},
									],
								};
							},
							async resolveLaunchConfig(input) {
								return {
									ok: true,
									launchConfig: {
										processId: "test_process",
										params: { repoPath: String(input.repoPath ?? "") },
										startTurnId: "test_turn",
										projects: [
											{
												key: "repo",
												repoLocator: String(input.repoPath ?? ""),
												baseBranch: "main",
												workBranch: "feature/test",
											},
										],
									},
								};
							},
						},
					});
				},
			}),
		]);

		const launchers = registry.listUiLaunchers();
		expect(launchers).toEqual([
			expect.objectContaining({
				id: "local_repo_ui",
				processId: "test_process",
				label: "Local Repo",
			}),
		]);
		expect(await registry.resolveUiDefaults("local_repo_ui")).toEqual({ repoPath: "/tmp/project" });
		expect(await registry.resolveUiOptions("local_repo_ui", { repoPath: "/tmp/other" })).toEqual({
			repoPath: [{ value: "/tmp/other", label: "Suggested repo" }],
		});
	});

	it("passes configured model profiles into launcher context for defaults and options", async () => {
		const registry = buildRegistry(
			[
				makeProcess({
					launchers(api) {
						api.launcher({
							id: "single_prompt_ui",
							label: "Single Prompt",
							description: "Run a single prompt",
							visibility: "ui",
							ui: {
								card: {},
								launchConfigSchema: {
									id: "single_prompt_form",
									title: "Single Prompt",
									fields: [{ id: "modelProfileId", label: "Model", kind: "select" }],
								},
								resolveDefaults(ctx) {
									return { modelProfileId: ctx.modelProfiles?.[0]?.id ?? "" };
								},
								resolveOptions(_input, ctx) {
									return {
										modelProfileId: (ctx.modelProfiles ?? []).map((profile) => ({
											value: profile.id,
											label: `${profile.id} → ${profile.provider}/${profile.modelId}`,
										})),
									};
								},
								resolveLaunchConfig(input) {
									return {
										ok: true,
										launchConfig: {
											processId: "test_process",
											params: { repoPath: String(input.modelProfileId ?? "") },
										},
									};
								},
							},
						});
					},
				}),
			],
			{
				modelProfiles: [
					{
						id: "claude_fast",
						provider: "anthropic",
						modelId: "claude-sonnet-4-20250514",
						thinkingLevel: "medium",
					},
				],
			},
		);

		expect(await registry.resolveUiDefaults("single_prompt_ui")).toEqual({
			modelProfileId: "claude_fast",
		});
		expect(await registry.resolveUiOptions("single_prompt_ui", {})).toEqual({
			modelProfileId: [
				{
					value: "claude_fast",
					label: "claude_fast → anthropic/claude-sonnet-4-20250514",
				},
			],
		});
	});

	it("filters launcher model profiles per process when a process-specific callback is provided", async () => {
		const registry = buildRegistry(
			[
				makeProcess({
					id: "process_a",
					launchers(api) {
						api.launcher({
							id: "process_a_launcher",
							label: "Process A",
							description: "A",
							visibility: "ui",
							ui: {
								card: {},
								launchConfigSchema: {
									id: "process_a_form",
									title: "Process A",
									fields: [],
								},
								resolveDefaults(ctx) {
									return {
										modelProfileId: ctx.modelProfiles?.map((profile) => profile.id) ?? [],
									};
								},
								resolveLaunchConfig() {
									return {
										ok: true,
										launchConfig: { processId: "process_a", params: { repoPath: "/tmp/a" } },
									};
								},
							},
						});
					},
				}),
				makeProcess({
					id: "process_b",
					launchers(api) {
						api.launcher({
							id: "process_b_launcher",
							label: "Process B",
							description: "B",
							visibility: "ui",
							ui: {
								card: {},
								launchConfigSchema: {
									id: "process_b_form",
									title: "Process B",
									fields: [],
								},
								resolveDefaults(ctx) {
									return {
										modelProfileId: ctx.modelProfiles?.map((profile) => profile.id) ?? [],
									};
								},
								resolveLaunchConfig() {
									return {
										ok: true,
										launchConfig: { processId: "process_b", params: { repoPath: "/tmp/b" } },
									};
								},
							},
						});
					},
				}),
			],
			{
				modelProfiles: [
					{
						id: "claude_fast",
						provider: "anthropic",
						modelId: "claude-sonnet-4-20250514",
						thinkingLevel: "medium",
					},
					{
						id: "local_qwen",
						provider: "ollama",
						modelId: "qwen2.5-coder:14b",
						thinkingLevel: "low",
					},
				],
				getModelProfilesForProcess(processId) {
					return processId === "process_a"
						? [
								{
									id: "local_qwen",
									provider: "ollama",
									modelId: "qwen2.5-coder:14b",
									thinkingLevel: "low",
								},
							]
						: [
								{
									id: "claude_fast",
									provider: "anthropic",
									modelId: "claude-sonnet-4-20250514",
									thinkingLevel: "medium",
								},
							];
				},
			},
		);

		expect(await registry.resolveUiDefaults("process_a_launcher")).toEqual({
			modelProfileId: ["local_qwen"],
		});
		expect(await registry.resolveUiDefaults("process_b_launcher")).toEqual({
			modelProfileId: ["claude_fast"],
		});
	});

	it("returns structured validation errors for invalid UI input", async () => {
		const registry = buildRegistry([
			makeProcess({
				launchers(api) {
					api.launcher({
						id: "local_repo_ui",
						label: "Local Repo",
						description: "Run against a local repository",
						visibility: "ui",
						ui: {
							card: {},
							launchConfigSchema: {
								id: "local_repo_form",
								title: "Local Repo",
								fields: [{ id: "repoPath", label: "Repo", kind: "text", required: true }],
							},
							resolveLaunchConfig(input) {
								if (typeof input.repoPath !== "string" || !input.repoPath.trim()) {
									return {
										ok: false,
										errors: [
											{
												code: "required",
												fieldId: "repoPath",
												message: "repoPath is required",
											},
										],
									};
								}
								return {
									ok: true,
									launchConfig: {
										processId: "test_process",
										params: { repoPath: input.repoPath },
									},
								};
							},
						},
					});
				},
			}),
		]);

		await expect(registry.resolveUiLauncher("local_repo_ui", {})).resolves.toEqual({
			ok: false,
			errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
		});
	});

	it("resolves UI launchers into normalized launch plans", async () => {
		const registry = buildRegistry([
			makeProcess({
				launchers(api) {
					api.launcher({
						id: "local_repo_ui",
						label: "Local Repo",
						description: "Run against a local repository",
						visibility: "ui",
						ui: {
							card: {},
							launchConfigSchema: {
								id: "local_repo_form",
								title: "Local Repo",
								fields: [{ id: "repoPath", label: "Repo", kind: "text", required: true }],
							},
							resolveLaunchConfig(input) {
								return {
									ok: true,
									launchConfig: {
										processId: "test_process",
										params: { repoPath: String(input.repoPath) },
										startTurnId: "test_turn",
										metadata: { requestedBy: "tester" },
									},
								};
							},
						},
					});
				},
			}),
		]);

		const resolved = await registry.resolveUiLauncher("local_repo_ui", {
			repoPath: "/tmp/project",
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			throw new Error("expected a resolved launcher");
		}
		expect(resolved.launcher.launchConfig).toMatchObject({
			processId: "test_process",
			params: { repoPath: "/tmp/project" },
			startTurnId: "test_turn",
		});
		expect(resolved.launcher.launchPlan.processInput).toMatchObject({
			processId: "test_process",
			lifecycleStatus: "discovered",
		});
		expect(resolved.launcher.launchPlan.processInput.paramsJson).toBe(
			JSON.stringify({ repoPath: "/tmp/project" }),
		);
		expect(resolved.launcher.launchPlan.processInput.stateJson).toBe(
			JSON.stringify({ initializedFrom: "/tmp/project" }),
		);
		expect(resolved.launcher.launchPlan.processInput.metadata).toEqual({
			requestedBy: "tester",
			launcherId: "local_repo_ui",
		});
	});

	it("canonicalizes explicit title metadata into the launch plan", async () => {
		const registry = buildRegistry([
			makeProcess({
				launchers(api) {
					api.launcher({
						id: "title_ui",
						label: "Title UI",
						description: "Launch with an explicit title",
						visibility: "ui",
						ui: {
							card: {},
							launchConfigSchema: {
								id: "title_form",
								title: "Title Form",
								fields: [{ id: "repoPath", label: "Repo", kind: "text", required: true }],
							},
							resolveLaunchConfig(input) {
								return {
									ok: true,
									launchConfig: {
										processId: "test_process",
										params: { repoPath: String(input.repoPath ?? "") },
										title: "  Human-readable\n title  ",
										titleSourceFields: [
											{ label: "Prompt", value: "Implement the requested repo change" },
										],
									},
								};
							},
						},
					});
				},
			}),
		]);

		const resolved = await registry.resolveUiLauncher("title_ui", { repoPath: "/tmp/project" });
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) {
			throw new Error("expected resolved launcher");
		}
		expect(resolved.launcher.launchPlan.processInput.title).toBe("Human-readable title");
		expect(resolved.launcher.launchPlan.titleSourceFields).toEqual([
			{ label: "Prompt", value: "Implement the requested repo change" },
		]);
	});
});
