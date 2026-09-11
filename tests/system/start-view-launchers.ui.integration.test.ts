import type { spawn } from "node:child_process";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	type Codec,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "@leitwerk-dev/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

interface LauncherUiTestParams {
	repoPath: string;
	prompt: string;
	baseBranch: string;
	maxTurns: number | null;
	startNow: boolean;
}

interface LauncherUiTestState {
	launchedFrom: string;
}

const defaultLauncherUiTestDefaults: Record<string, unknown> = {
	repoPath: "/tmp/default-repo",
	prompt: "Ship the local repo flow",
	baseBranch: "main",
	maxTurns: 3,
	startNow: false,
};

let launcherUiTestDefaults: Record<string, unknown> = { ...defaultLauncherUiTestDefaults };

function resetLauncherUiTestFixtures() {
	launcherUiTestDefaults = { ...defaultLauncherUiTestDefaults };
}

const launcherEntryTurn = {
	id: "launcher_entry_turn",
	description: "Launcher setup turn",
	availableTools: [],
	kind: "llm" as const,
	completionMode: "turn_end" as const,
	branchType: "primary" as const,
	context: "fresh" as const,
	prompt: async () => "Plan the launcher flow",
	outcomes: {},
	turnEnd: { outcome: "completed" as const, params: {}, complete: true },
};

const launcherUiTestParamsCodec: Codec<LauncherUiTestParams> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			repoPath:
				typeof (record as { repoPath?: unknown }).repoPath === "string"
					? (record as { repoPath: string }).repoPath
					: "",
			prompt:
				typeof (record as { prompt?: unknown }).prompt === "string"
					? (record as { prompt: string }).prompt
					: "",
			baseBranch:
				typeof (record as { baseBranch?: unknown }).baseBranch === "string"
					? (record as { baseBranch: string }).baseBranch
					: "main",
			maxTurns:
				typeof (record as { maxTurns?: unknown }).maxTurns === "number" &&
				Number.isFinite((record as { maxTurns: number }).maxTurns)
					? (record as { maxTurns: number }).maxTurns
					: null,
			startNow: (record as { startNow?: unknown }).startNow === true,
		};
	},
	serialize(value) {
		return value;
	},
};

const launcherUiTestStateCodec: Codec<LauncherUiTestState> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			launchedFrom:
				typeof (record as { launchedFrom?: unknown }).launchedFrom === "string"
					? (record as { launchedFrom: string }).launchedFrom
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

const launcherUiTestProcess = defineProcess<LauncherUiTestParams, LauncherUiTestState>({
	id: "launcher_ui_test_process",
	displayName: "Launcher UI Test Process",
	entry: launcherEntryTurn.id,
	turns: { [launcherEntryTurn.id]: launcherEntryTurn },
	paramsCodec: launcherUiTestParamsCodec,
	stateCodec: launcherUiTestStateCodec,
	initialState(params) {
		return { launchedFrom: params.repoPath };
	},
	worker(api) {
		api.start("launcher_entry_turn");
	},
	launchers(api) {
		api.launcher({
			id: "launcher_ui_test_process.local_repo_ui",
			label: "Local Repo Flow",
			description: "Launch from a local repository",
			visibility: "ui",
			ui: {
				card: {
					title: "Local Repo Flow",
					description: "Start from a local clone workspace.",
				},
				launchConfigSchema: {
					id: "local_repo_flow_form",
					title: "Local Repo Flow",
					fields: [
						{
							id: "repoPath",
							label: "Repo Path",
							kind: "text",
							required: true,
							placeholder: "/tmp/project",
						},
						{
							id: "prompt",
							label: "Prompt",
							kind: "textarea",
							required: true,
							description: "Describe the change to make.",
						},
						{
							id: "baseBranch",
							label: "Base Branch",
							kind: "select",
						},
						{
							id: "maxTurns",
							label: "Max Turns",
							kind: "number",
							description: "Optional limit used to exercise numeric launcher input handling.",
						},
						{
							id: "startNow",
							label: "Start Now",
							kind: "boolean",
						},
					],
					submitLabel: "Launch Process",
				},
				resolveDefaults() {
					return { ...launcherUiTestDefaults };
				},
				resolveOptions(input) {
					const repoPath =
						typeof input.repoPath === "string" && input.repoPath.trim() !== ""
							? input.repoPath.trim()
							: "/tmp/default-repo";
					const repoName = repoPath.split("/").filter(Boolean).at(-1) ?? "repo";
					const baseBranch =
						typeof input.baseBranch === "string" && input.baseBranch.trim() !== ""
							? input.baseBranch.trim()
							: "main";
					return {
						baseBranch: [
							{
								value: baseBranch,
								label: `Use ${baseBranch}`,
								description: `Default branch suggestion for ${repoName}`,
							},
							{
								value: "develop",
								label: `Develop (${repoName})`,
								description: `Alternate shared branch for ${repoName}`,
							},
							...(repoName === "frontend"
								? [
										{
											value: "release/frontend",
											label: "Release frontend",
											description: "Release branch exposed only for frontend repos",
										},
									]
								: []),
						],
					};
				},
				resolveLaunchConfig(input) {
					const repoPath = typeof input.repoPath === "string" ? input.repoPath.trim() : "";
					const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
					const baseBranch =
						typeof input.baseBranch === "string" && input.baseBranch.trim() !== ""
							? input.baseBranch.trim()
							: "main";
					const maxTurns =
						typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns)
							? input.maxTurns
							: null;
					if (!repoPath) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
						};
					}
					if (!prompt) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
						};
					}
					if (input.maxTurns !== undefined && input.maxTurns !== "" && maxTurns === null) {
						return {
							ok: false,
							errors: [
								{ code: "invalid", fieldId: "maxTurns", message: "maxTurns must be a number" },
							],
						};
					}
					return {
						ok: true,
						launchConfig: {
							processId: "launcher_ui_test_process",
							params: {
								repoPath,
								prompt,
								baseBranch,
								maxTurns,
								startNow: input.startNow === true,
							},
							...(input.startNow === true ? { startTurnId: "launcher_entry_turn" as const } : {}),
							projects: [
								{
									key: "repo",
									repoLocator: repoPath,
									baseBranch,
									workBranch: "feature/local-repo-flow",
								},
							],
						},
					};
				},
			},
		});
	},
});

const launcherUiTestExtension: LeitwerkExtensionModule = {
	manifest: { id: "launcher-ui-test", version: "0.1.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "anthropic",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("anthropic"),
				models: () => [{ modelId: "claude-fast", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
	setupCatalog(api) {
		api.registerProcess(launcherUiTestProcess);
	},
};

function configureLauncherModel(config: LeitwerkConfig) {
	config.pi.model_profiles = [
		{
			id: "claude_fast",
			provider: "anthropic",
			model_id: "claude-fast",
			thinking_level: "medium",
		},
	];
}

const extensionCatalog = buildExtensionCatalogFromModules([launcherUiTestExtension]);
const emptyExtensionCatalog = buildExtensionCatalogFromModules([]);

async function findButton(label: string): Promise<HTMLButtonElement> {
	return waitFor(() => {
		const match = [...document.querySelectorAll("button")].find((candidate) =>
			candidate.textContent?.includes(label),
		);
		expect(match).toBeDefined();
		return match as HTMLButtonElement;
	});
}

async function clickButton(label: string): Promise<void> {
	const button = await findButton(label);
	button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function findInputById<T extends HTMLElement>(id: string): Promise<T> {
	return waitFor(() => {
		const element = document.getElementById(id);
		expect(element).toBeTruthy();
		return element as T;
	});
}

async function setTextControlValue(id: string, value: string): Promise<void> {
	const element = await findInputById<HTMLInputElement | HTMLTextAreaElement>(id);
	element.value = value;
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function setSelectValue(id: string, value: string): Promise<void> {
	const element = await findInputById<HTMLSelectElement>(id);
	element.value = value;
	element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function setCheckboxValue(id: string, checked: boolean): Promise<void> {
	const element = await findInputById<HTMLInputElement>(id);
	element.checked = checked;
	element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function setUnsafeInputValue(id: string, value: string): Promise<void> {
	const element = await findInputById<HTMLInputElement>(id);
	Object.defineProperty(element, "value", {
		configurable: true,
		value,
		writable: true,
	});
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickElement(selector: string): Promise<HTMLElement> {
	const element = await waitFor(() => {
		const found = document.querySelector(selector);
		expect(found).toBeTruthy();
		return found as HTMLElement;
	});
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	return element;
}

describe("start view launcher UI", () => {
	beforeEach(() => {
		resetLauncherUiTestFixtures();
	});

	it("retries launcher-list loading after an initial failure", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/",
				extensionCatalog,
				configureConfig: configureLauncherModel,
				initialFetchFailures: [{ path: "/api/launchers", status: 503 }],
			});

			await waitFor(() =>
				expect(document.body.textContent).toContain("Couldn't load available processes: 503"),
			);
			await clickButton("Retry");
			await waitFor(() => expect(document.body.textContent).toContain("Local Repo Flow"));
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("shows an empty launcher state when no UI launchers are available", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/",
				extensionCatalog: emptyExtensionCatalog,
			});

			await waitFor(() => expect(document.body.textContent).toContain("Start a process"));
			await waitFor(() =>
				expect(document.body.textContent).toContain("No process types are available yet."),
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("renders the home page with active sidebar work and the default launcher form", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/",
				extensionCatalog,
				configureConfig: configureLauncherModel,
				async prepare(testApp) {
					testApp.ctx.deps.processes.create({
						processId: "launcher_ui_test_process",
						selectedTurnId: "launcher_entry_turn",
						lifecycleStatus: "active",
						externalId: "RUN-101",
					});
					testApp.ctx.deps.processes.create({
						processId: "launcher_ui_test_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "DONE-101",
					});
				},
			});

			await waitFor(() => expect(document.querySelector('[data-column="sidebar"]')).not.toBeNull());
			await waitFor(() =>
				expect(document.querySelector('[data-section="process-gallery"]')).not.toBeNull(),
			);
			await waitFor(() => expect(document.body.textContent).toContain("Future"));
			await waitFor(() => expect(document.body.textContent).toContain("Active"));
			await waitFor(() => expect(document.body.textContent).toContain("All processes"));
			await waitFor(() => expect(document.body.textContent).toContain("RUN-101"));
			expect(document.body.textContent).not.toContain("DONE-101");
			await waitFor(() => expect(document.body.textContent).toContain("Local Repo Flow"));
			expect(document.querySelector('[data-section="launcher-form"]')).toBeNull();

			await clickButton("Local Repo Flow");
			await waitFor(() =>
				expect(document.querySelector('[data-section="process-configure"]')).not.toBeNull(),
			);

			const repoPathInput = await findInputById<HTMLInputElement>("local_repo_flow_form-repoPath");
			const promptInput = await findInputById<HTMLTextAreaElement>("local_repo_flow_form-prompt");
			const baseBranchSelect = await findInputById<HTMLSelectElement>(
				"local_repo_flow_form-baseBranch",
			);
			const maxTurnsInput = await findInputById<HTMLInputElement>("local_repo_flow_form-maxTurns");
			const startNowCheckbox = await findInputById<HTMLInputElement>(
				"local_repo_flow_form-startNow",
			);

			await waitFor(() =>
				expect(
					harness?.fetchHarness.count(
						"/api/launchers/launcher_ui_test_process.local_repo_ui/options",
					),
				).toBeGreaterThanOrEqual(1),
			);
			await waitFor(() =>
				expect(
					[...baseBranchSelect.options].some((option) => option.text === "Develop (default-repo)"),
				).toBe(true),
			);
			await waitFor(() =>
				expect(document.body.textContent).toContain("Default branch suggestion for default-repo"),
			);

			expect(repoPathInput.value).toBe("/tmp/default-repo");
			expect(promptInput.value).toBe("Ship the local repo flow");
			expect(baseBranchSelect.value).toBe("main");
			expect(maxTurnsInput.value).toBe("3");
			expect(startNowCheckbox.checked).toBe(false);
			await waitFor(() => expect(document.body.textContent).toContain("Launch Process"));
		} finally {
			await teardownMountedUiHarness(harness);
		}
	}, 15_000);

	it("shows the effective model preview in the main flow and keeps overrides behind advanced disclosure", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
			});

			const summaryCard = await waitFor(() => {
				const element = document.querySelector('[data-section="launcher-model-config-summary"]');
				expect(element).toBeTruthy();
				return element as HTMLElement;
			});

			expect(summaryCard.dataset.summaryMode).toBe("recommended");
			expect(summaryCard.dataset.customizationMode).toBe("recommended");
			expect(summaryCard.dataset.editing).toBe("false");

			await clickElement('[data-action="toggle-model-config-editor"]');

			const turnList = await waitFor(() => {
				const element = document.querySelector('[data-section="launcher-model-config-turn-list"]');
				expect(element).toBeTruthy();
				expect((summaryCard as HTMLElement).dataset.editing).toBe("true");
				return element as HTMLElement;
			});
			const defaultModelGroup = await waitFor(() => {
				const element = document.querySelector('[data-section="launcher-model-config-default"]');
				expect(element).toBeTruthy();
				return element as HTMLElement;
			});
			const defaultModelSelect = await findInputById<HTMLSelectElement>(
				"local_repo_flow_form-default-model-profile",
			);

			expect(turnList.dataset.open).toBe("true");
			expect(turnList.dataset.overrideCount).toBe("0");
			expect(defaultModelGroup.dataset.effectiveSource).toBe("catalog_default");
			expect(defaultModelGroup.dataset.effectiveProfileId).toBe("claude_fast");
			expect(defaultModelSelect.options[0]?.value).toBe("");
			await waitFor(() => {
				const turnGroup = document.querySelector(
					'[data-turn-id="launcher_entry_turn"]',
				) as HTMLElement | null;
				expect(turnGroup).not.toBeNull();
				expect(turnGroup?.dataset.effectiveSource).toBe("catalog_default");
				expect(turnGroup?.dataset.effectiveProfileId).toBe("claude_fast");
			});
		} finally {
			await teardownMountedUiHarness(harness);
		}
	}, 15_000);

	it("retries launcher-default loading after a failure", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
				initialFetchFailures: [
					{
						path: "/api/launchers/launcher_ui_test_process.local_repo_ui/defaults",
						status: 503,
					},
				],
			});

			await waitFor(() =>
				expect(document.body.textContent).toContain("Couldn't load default values: 503"),
			);
			await clickButton("Retry");
			const repoPathInput = await findInputById<HTMLInputElement>("local_repo_flow_form-repoPath");
			expect(repoPathInput.value).toBe("/tmp/default-repo");
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("refreshes dynamic launcher options while the operator edits launcher input", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
			});

			await waitFor(() =>
				expect(
					harness?.fetchHarness.count(
						"/api/launchers/launcher_ui_test_process.local_repo_ui/options",
					),
				).toBeGreaterThanOrEqual(1),
			);
			await setTextControlValue("local_repo_flow_form-repoPath", "/tmp/frontend");
			await waitFor(() =>
				expect(
					harness?.fetchHarness.count(
						"/api/launchers/launcher_ui_test_process.local_repo_ui/options",
					),
				).toBeGreaterThanOrEqual(2),
			);
			await waitFor(() => {
				const baseBranchSelect = document.getElementById(
					"local_repo_flow_form-baseBranch",
				) as HTMLSelectElement | null;
				expect(baseBranchSelect).not.toBeNull();
				expect(
					[...(baseBranchSelect?.options ?? [])].some(
						(option) => option.text === "Release frontend",
					),
				).toBe(true);
			});
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("preserves raw numeric input until submit so server validation can reject invalid numbers", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
			});

			await setTextControlValue("local_repo_flow_form-repoPath", "/tmp/number-test-repo");
			await setTextControlValue("local_repo_flow_form-prompt", "Validate number handling");
			await setUnsafeInputValue("local_repo_flow_form-maxTurns", "-");
			await clickButton("Launch Process");
			await waitFor(() =>
				expect(document.body.textContent).toContain("Process startup needs attention"),
			);
			const startupSummary = await findButton("Process startup needs attention");
			expect(startupSummary.getAttribute("aria-expanded")).toBe("false");
			await clickButton("Process startup needs attention");
			await clickButton("Try again");
			const maxTurnsInput = document.getElementById(
				"local_repo_flow_form-maxTurns",
			) as HTMLInputElement | null;
			expect(maxTurnsInput?.value).toBe("-");
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("shows server validation errors for invalid launcher input", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
			});

			await setTextControlValue("local_repo_flow_form-repoPath", "");
			await clickButton("Launch Process");
			await clickButton("Process startup needs attention");
			await waitFor(() =>
				expect(document.body.textContent).toContain(
					"Review the highlighted launcher fields and try again.",
				),
			);
			await clickButton("Try again");
			const repoPathInput = document.getElementById(
				"local_repo_flow_form-repoPath",
			) as HTMLInputElement | null;
			expect(repoPathInput?.value).toBe("");
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("submits the generic launcher form and navigates to the new process detail view", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
			});

			await setTextControlValue("local_repo_flow_form-repoPath", "/tmp/launched-repo");
			await setTextControlValue("local_repo_flow_form-prompt", "Implement the start view");
			await waitFor(() => {
				const select = document.getElementById(
					"local_repo_flow_form-baseBranch",
				) as HTMLSelectElement | null;
				expect(select).not.toBeNull();
				expect(
					[...((select as HTMLSelectElement).options ?? [])].some(
						(option) => option.value === "develop",
					),
				).toBe(true);
			});
			await setSelectValue("local_repo_flow_form-baseBranch", "develop");
			await waitFor(() =>
				expect(
					(document.getElementById("local_repo_flow_form-baseBranch") as HTMLSelectElement | null)
						?.value,
				).toBe("develop"),
			);
			await setTextControlValue("local_repo_flow_form-maxTurns", "5");
			await clickButton("Launch Process");

			await waitFor(() => expect(window.location.pathname).toMatch(/^\/processes\//));
			await waitFor(() =>
				expect(document.querySelector('[data-page="process-detail"]')).not.toBeNull(),
			);

			const launched = harness.testApp.ctx.deps.processes
				.listAll()
				.find((process) => process.paramsJson?.includes("/tmp/launched-repo"));
			expect(launched).toBeDefined();
			expect(launched?.paramsJson).toContain("develop");
			expect(launched?.paramsJson).toContain('"maxTurns":5');
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("preserves stale launchers on reconnect refresh failure", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/",
				extensionCatalog,
				configureConfig: configureLauncherModel,
				fastReconnect: true,
			});

			await waitFor(() => expect(document.body.textContent).toContain("Local Repo Flow"));
			await waitFor(() =>
				expect(harness?.fetchHarness.count("/api/launchers")).toBeGreaterThanOrEqual(1),
			);
			harness.fetchHarness.failNext("/api/launchers", 503);
			harness.socketObserver.closeActive();

			await waitFor(() => expect(harness?.socketObserver.getCreatedCount()).toBe(2));
			await waitFor(() =>
				expect(harness?.fetchHarness.count("/api/launchers")).toBeGreaterThanOrEqual(2),
			);
			await waitFor(() =>
				expect(document.body.textContent).toContain("showing the last process list we loaded."),
			);
			expect(document.body.textContent).toContain("Local Repo Flow");
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("refreshes selected launcher defaults after reconnect when launcher data changes", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
				fastReconnect: true,
			});

			await waitFor(() =>
				expect(
					(document.getElementById("local_repo_flow_form-repoPath") as HTMLInputElement | null)
						?.value,
				).toBe("/tmp/default-repo"),
			);

			launcherUiTestDefaults = {
				...defaultLauncherUiTestDefaults,
				repoPath: "/tmp/reconnected-repo",
				maxTurns: 7,
			};
			harness.socketObserver.closeActive();

			await waitFor(() => expect(harness?.socketObserver.getCreatedCount()).toBe(2));
			await waitFor(() =>
				expect(
					(document.getElementById("local_repo_flow_form-repoPath") as HTMLInputElement | null)
						?.value,
				).toBe("/tmp/reconnected-repo"),
			);
			await waitFor(() =>
				expect(
					(document.getElementById("local_repo_flow_form-maxTurns") as HTMLInputElement | null)
						?.value,
				).toBe("7"),
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("shows an explicit warning when launch creates the process but immediate start fails", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			const failingSpawn = (() => {
				throw new Error("spawn failed intentionally");
			}) as typeof spawn;
			harness = await setupMountedUiHarness({
				route: "/?launcher=launcher_ui_test_process.local_repo_ui",
				extensionCatalog,
				configureConfig: configureLauncherModel,
				localWorkerSpawnImpl: failingSpawn,
			});

			await setTextControlValue("local_repo_flow_form-repoPath", "/tmp/partial-success-repo");
			await setTextControlValue("local_repo_flow_form-prompt", "Start immediately");
			await setCheckboxValue("local_repo_flow_form-startNow", true);
			await clickButton("Launch Process");

			await waitFor(() => expect(window.location.pathname).toMatch(/^\/processes\/agt_/));
			await waitFor(() =>
				expect(document.body.textContent).toContain(
					"Process was created, but the worker could not be started cleanly",
				),
			);
			await waitFor(() => expect(document.body.textContent).toContain("Launcher UI Test Process"));
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
