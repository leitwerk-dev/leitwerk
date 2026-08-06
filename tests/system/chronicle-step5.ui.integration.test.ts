import path from "node:path";
import { buildExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { createLoadedExtensionModuleForTest } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "@leitwerk-dev/server";
import singlePromptExtension, {
	buildPoemLeafOutcomeFallbackMarkdown,
	buildPoemLeafOutcomePayload,
} from "@leitwerk-dev/showcase-processes";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const singlePromptPackageDir = path.resolve(process.cwd(), "extensions/showcase-processes");
const singlePromptExtensionWithProvider = {
	...singlePromptExtension,
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
};
type TestApp = NonNullable<MountedUiHarness<Record<string, never>>["testApp"]>;
type AcceptedLlmTurnFixtureInput = Parameters<
	TestApp["ctx"]["deps"]["turnRecords"]["create"]
>[0] & { id: string; turnType: "llm" };

function createAcceptedLlmTurn(testApp: TestApp, input: AcceptedLlmTurnFixtureInput) {
	const running = input.status === "running";
	const lease = testApp.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_fixture_${input.id}`,
		state: running ? "busy" : "exited",
	});
	const start = testApp.ctx.deps.turnStarts.create({
		id: `tsr_fixture_${input.id}`,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.id,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: input.modelProfileId ?? "test",
					providerId: "test",
					modelId: "test",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "system-fixture-digest",
				workerRuntimeProfileId: "test",
				piSettings: {},
			},
			turnRecordId: input.id,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const turnRecord = testApp.ctx.deps.turnRecords.create({
		...input,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	if (running) {
		testApp.ctx.deps.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	} else {
		testApp.ctx.deps.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
		});
	}
	return turnRecord;
}

async function createRealSinglePromptCatalog() {
	return buildExtensionCatalog([
		createLoadedExtensionModuleForTest(singlePromptExtensionWithProvider, {
			packageName: "@leitwerk-dev/showcase-processes",
			packageDir: singlePromptPackageDir,
			entryPath: path.join(singlePromptPackageDir, "src/index.ts"),
		}),
	]);
}

function configurePoemModel(config: LeitwerkConfig) {
	config.pi.model_profiles = [
		{
			id: "claude_fast",
			provider: "anthropic",
			model_id: "claude-fast",
			thinking_level: "medium",
		},
	];
}

function createPoemDraftSequenceSpawn(markdowns: readonly string[]) {
	let draftIndex = 0;
	const extensionCatalog = createRealSinglePromptCatalog();
	return createInProcessWorkerSpawn({
		extensionCatalog,
		toolCallScriptResolver({ tools }) {
			const turnTools = tools.filter((tool) => tool.name !== "upload_result_images");
			const toolNames = new Set(turnTools.map((tool) => tool.name));
			if (toolNames.has("leave_feedback")) {
				return {
					toolName: "leave_feedback",
					args: {
						summary: "The poem needs a brighter ending.",
						feedback: "Tighten the last image and make the closing line more luminous.",
					},
				};
			}
			if (toolNames.has("no_issues")) {
				return {
					toolName: "no_issues",
					args: {
						summary: "The revised poem is ready to publish.",
					},
				};
			}
			if ((toolNames.has("markdown_result") && turnTools.length === 1) || turnTools.length === 0) {
				const markdown =
					markdowns[Math.min(draftIndex, markdowns.length - 1)] ?? "# Untitled\n\nNo poem";
				draftIndex += 1;
				return {
					toolName: "markdown_result",
					args: { markdown },
				};
			}
			return undefined;
		},
	});
}

async function launchPoemCreator(
	testApp: NonNullable<MountedUiHarness<Record<string, never>>["testApp"]>,
	prompt: string,
) {
	const response = await fetch(
		`${testApp.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				launcherInput: {
					prompt,
				},
				modelConfig: {
					defaultModelProfileId: "claude_fast",
				},
			}),
		},
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as {
		process: { id: string };
	};
	return body.process.id;
}

async function runProcessAction(
	testApp: NonNullable<MountedUiHarness<Record<string, never>>["testApp"]>,
	instanceId: string,
	actionId: string,
	input: Record<string, unknown> = {},
) {
	const response = await fetch(
		`${testApp.address}/api/processes/${encodeURIComponent(instanceId)}/actions/${encodeURIComponent(actionId)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ input }),
		},
	);
	expect(response.status).toBe(200);
}

async function findElement<T extends Element>(selector: string): Promise<T> {
	return waitFor(() => {
		const element = document.querySelector(selector);
		expect(element).not.toBeNull();
		return element as T;
	});
}

describe("chronicle step 5 poem outcome renderer", () => {
	it("renders the active action row directly below the latest leaf outcome and keeps it on the newest outcome after revision", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;
		const extensionCatalog = await createRealSinglePromptCatalog();

		try {
			const instanceIdRef = { value: "" };
			harness = await setupMountedUiHarness({
				extensionCatalog,
				configureConfig: configurePoemModel,
				localWorkerSpawnImpl: createPoemDraftSequenceSpawn([
					"# Berlin Release\n\nTin rooftops glimmer<br>Blue tram wires sing\n\nDeploy lights gather<br>At the edge of spring",
					"# Brighter Deploys\n\nTin rooftops shimmer<br>Warmer circuits ring\n\nRelease trains brighten<br>With a cleaner spring",
				]),
				route: () => `/processes/${instanceIdRef.value}`,
				async prepare(testApp) {
					const instanceId = await launchPoemCreator(
						testApp,
						"Write a short poem about Berlin release trains and spring deployments.",
					);
					instanceIdRef.value = instanceId;

					await waitForValue(
						() => testApp.ctx.deps.processes.getById(instanceId),
						(process) =>
							process?.selectedTurnId === "poem_review" && process.lifecycleStatus === "waiting",
					);
					await waitForValue(
						() => testApp.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
						(snapshots) => snapshots.length === 1,
					);
				},
			});

			await waitFor(() =>
				expect(document.querySelectorAll("o2-showcase-processes-poem-outcome").length).toBe(1),
			);
			const initialLeafOutcome = await findElement<HTMLElement>(
				'[data-section="leaf-outcome"][data-status="ready"]',
			);
			const initialActionSection = await findElement<HTMLElement>(
				'[data-section="leaf-outcome-actions"]',
			);
			expect(initialLeafOutcome.nextElementSibling).toBe(initialActionSection);
			expect(initialActionSection.textContent).toContain("Complete poem");
			expect(initialActionSection.textContent).toContain("Request revision");
			expect(initialActionSection.textContent).toContain("Run automated review");

			const requestRevisionButton = await findElement<HTMLButtonElement>(
				'[data-section="leaf-outcome-actions"] [data-action-id="request_poem_revision"]',
			);
			requestRevisionButton.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);

			const messageField = await findElement<HTMLTextAreaElement>(
				"#process-action-request_poem_revision-message",
			);
			messageField.value =
				"Keep the Berlin imagery, but make the ending feel brighter and more confident.";
			messageField.dispatchEvent(new Event("input", { bubbles: true }));

			const revisionForm = await findElement<HTMLFormElement>(
				'[data-action-form-id="request_poem_revision"]',
			);
			revisionForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

			await waitForValue(
				() =>
					harness?.testApp?.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceIdRef.value) ?? [],
				(snapshots) => snapshots.length === 2,
			);
			await waitFor(() =>
				expect(document.querySelectorAll("o2-showcase-processes-poem-outcome").length).toBe(2),
			);
			await waitFor(() =>
				expect(document.querySelectorAll('[data-section="leaf-outcome-actions"]').length).toBe(1),
			);

			const leafOutcomes = [
				...document.querySelectorAll<HTMLElement>(
					'[data-section="leaf-outcome"][data-status="ready"]',
				),
			];
			expect(leafOutcomes).toHaveLength(2);
			const latestLeafOutcome = leafOutcomes.at(-1);
			const latestActionSection = document.querySelector(
				'[data-section="leaf-outcome-actions"]',
			) as HTMLElement | null;
			expect(latestLeafOutcome?.nextElementSibling).toBe(latestActionSection);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("renders the real poem outcome renderer end-to-end, preserves historical drafts, and keeps a live tail visible", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;
		const extensionCatalog = await createRealSinglePromptCatalog();

		try {
			const instanceIdRef = { value: "" };
			harness = await setupMountedUiHarness({
				extensionCatalog,
				configureConfig: configurePoemModel,
				localWorkerSpawnImpl: createPoemDraftSequenceSpawn([
					"# Berlin Release\n\nTin rooftops glimmer<br>Blue tram wires sing\n\nDeploy lights gather<br>At the edge of spring",
					"# Brighter Deploys\n\nTin rooftops shimmer<br>Warmer circuits ring\n\nRelease trains brighten<br>With a cleaner spring",
				]),
				route: () => `/processes/${instanceIdRef.value}`,
				async prepare(testApp) {
					const instanceId = await launchPoemCreator(
						testApp,
						"Write a short poem about Berlin release trains and spring deployments.",
					);
					instanceIdRef.value = instanceId;

					await waitForValue(
						() => testApp.ctx.deps.processes.getById(instanceId),
						(process) =>
							process?.selectedTurnId === "poem_review" && process.lifecycleStatus === "waiting",
					);
					await waitForValue(
						() => testApp.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
						(snapshots) => snapshots.length === 1,
					);

					await runProcessAction(testApp, instanceId, "request_poem_revision", {
						message:
							"Keep the Berlin imagery, but make the ending feel brighter and more confident.",
					});
					await waitForValue(
						() => testApp.ctx.deps.leafOutcomeSnapshots.listByInstance(instanceId),
						(snapshots) => snapshots.length === 2,
					);
					await waitForValue(
						() => testApp.ctx.deps.processes.getById(instanceId),
						(process) =>
							process?.selectedTurnId === "poem_review" && process.lifecycleStatus === "waiting",
					);

					const lease = testApp.ctx.deps.leases.create({
						instanceId,
						workerId: "worker_poem_live_review",
						state: "busy",
					});
					testApp.ctx.deps.turnStarts.create({
						id: "tsr_poem_live_review",
						instanceId,
						turnId: "review_poem_draft",
						turnType: "llm",
						proposedTurnRecordId: "trn_poem_live_review",
						startKind: "selected_turn",
						recoveryTurnRecordId: null,
						continuation: null,
						state: {
							kind: "accepted",
							start: {
								kind: "llm",
								model: {
									profileId: "test",
									providerId: "test",
									modelId: "test",
									thinkingLevel: "off",
								},
								providerOptions: {},
								providerWorkerConfig: null,
								piResourceSnapshotDigest: "test-digest",
								workerRuntimeProfileId: "test",
								piSettings: {},
							},
							turnRecordId: "trn_poem_live_review",
							acceptedWorkerLeaseId: lease.id,
						},
					});
					testApp.ctx.deps.turnRecords.create({
						id: "trn_poem_live_review",
						instanceId,
						turnId: "review_poem_draft",
						turnType: "llm",
						status: "running",
						pathType: "leaf_branch",
						forkPiEntryId: null,
						resultPiEntryId: null,
						turnResultMarkdown: null,
						errorSummary: null,
						startedAt: "2026-04-18T15:05:00.000Z",
						endedAt: null,
						turnStartRecordId: "tsr_poem_live_review",
						acceptedWorkerLeaseId: lease.id,
					});
					testApp.ctx.deps.processes.update(instanceId, {
						selectedTurnId: "review_poem_draft",
						lifecycleStatus: "active",
						currentExecution: { kind: "worker_start", id: "tsr_poem_live_review" },
					});
				},
			});

			await waitFor(() =>
				expect(document.querySelectorAll("o2-showcase-processes-poem-outcome").length).toBe(2),
			);
			const renderedPoems = [
				...document.querySelectorAll<HTMLElement>("o2-showcase-processes-poem-outcome"),
			];
			const firstPoem = renderedPoems[0] as HTMLElement & { shadowRoot: ShadowRoot | null };
			const secondPoem = renderedPoems[1] as HTMLElement & { shadowRoot: ShadowRoot | null };
			await waitFor(() =>
				expect(firstPoem.shadowRoot?.textContent ?? "").toContain("Berlin Release"),
			);
			await waitFor(() =>
				expect(firstPoem.shadowRoot?.textContent ?? "").toContain("Deploy lights gather"),
			);
			await waitFor(() =>
				expect(secondPoem.shadowRoot?.textContent ?? "").toContain("Brighter Deploys"),
			);
			await waitFor(() =>
				expect(secondPoem.shadowRoot?.textContent ?? "").toContain("Release trains brighten"),
			);
			await waitFor(() =>
				expect(
					document.querySelector('[data-section="live-tail"][data-turn-id="review_poem_draft"]'),
				).not.toBeNull(),
			);
			expect(document.querySelector("[data-warning-code]")).toBeNull();
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("renders review findings and no-issues opinions inside the real poem outcome renderer", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;
		const extensionCatalog = await createRealSinglePromptCatalog();

		try {
			const instanceIdRef = { value: "" };
			harness = await setupMountedUiHarness({
				extensionCatalog,
				configureConfig: configurePoemModel,
				route: () => `/processes/${instanceIdRef.value}`,
				async prepare(testApp) {
					const prompt = "Write a short poem about Berlin release trains and spring deployments.";
					const process = testApp.ctx.deps.processes.create({
						processId: "poem_creator_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "CHRON-P5-REVIEW",
						paramsJson: JSON.stringify({ prompt }),
					});
					instanceIdRef.value = process.id;

					for (const snapshot of [
						{
							turnRecordId: "trn_poem_review_feedback",
							leafEntryId: "assistant-poem-review-feedback",
							anchoredAt: "2026-04-18T16:00:04.000Z",
							outcome: "leave_feedback",
							review: {
								outcome: "leave_feedback" as const,
								summary: "The poem needs a brighter ending.",
								feedback: "Tighten the last image and make the closing line more luminous.",
							},
							markdown:
								"# Berlin Release\n\nTin rooftops glimmer<br>Blue tram wires sing\n\nDeploy lights gather<br>At the edge of spring",
						},
						{
							turnRecordId: "trn_poem_review_no_issues",
							leafEntryId: "assistant-poem-review-no-issues",
							anchoredAt: "2026-04-18T16:05:04.000Z",
							outcome: "no_issues",
							review: {
								outcome: "no_issues" as const,
								summary: "The revised poem is ready to publish.",
							},
							markdown:
								"# Brighter Deploys\n\nTin rooftops shimmer<br>Warmer circuits ring\n\nRelease trains brighten<br>With a cleaner spring",
						},
					] as const) {
						createAcceptedLlmTurn(testApp, {
							id: snapshot.turnRecordId,
							instanceId: process.id,
							turnId: "review_poem_draft",
							turnType: "llm",
							status: "succeeded",
							pathType: "leaf_branch",
							forkPiEntryId: null,
							resultPiEntryId: snapshot.leafEntryId,
							turnResultMarkdown: null,
							errorSummary: null,
							startedAt: snapshot.anchoredAt,
							endedAt: snapshot.anchoredAt,
						});
						testApp.ctx.deps.events.create({
							instanceId: process.id,
							eventType: "turn_outcome_recorded",
							data: {
								turnRecordId: snapshot.turnRecordId,
								turnId: "review_poem_draft",
								outcome: snapshot.outcome,
								params: snapshot.review,
							},
						});
						testApp.ctx.deps.leafOutcomeSnapshots.create({
							instanceId: process.id,
							leafEntryId: snapshot.leafEntryId,
							turnRecordId: snapshot.turnRecordId,
							rendererId: "@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome",
							schemaVersion: 1,
							props: buildPoemLeafOutcomePayload({
								prompt,
								markdown: snapshot.markdown,
								review: snapshot.review,
							}),
							fallbackMarkdown: buildPoemLeafOutcomeFallbackMarkdown({
								markdown: snapshot.markdown,
								review: snapshot.review,
							}),
							status: "ready",
							anchoredAt: snapshot.anchoredAt,
						});
					}
				},
			});

			await waitFor(() =>
				expect(document.querySelectorAll("o2-showcase-processes-poem-outcome").length).toBe(2),
			);
			const renderedPoems = [
				...document.querySelectorAll<HTMLElement>("o2-showcase-processes-poem-outcome"),
			] as Array<HTMLElement & { shadowRoot: ShadowRoot | null }>;
			const findingsRenderer = renderedPoems[0];
			const noIssuesRenderer = renderedPoems[1];
			await waitFor(() =>
				expect(findingsRenderer.shadowRoot?.textContent ?? "").toContain("Review"),
			);
			await waitFor(() =>
				expect(findingsRenderer.shadowRoot?.textContent ?? "").toContain(
					"The poem needs a brighter ending.",
				),
			);
			await waitFor(() =>
				expect(findingsRenderer.shadowRoot?.textContent ?? "").toContain(
					"Tighten the last image and make the closing line more luminous.",
				),
			);
			await waitFor(() =>
				expect(noIssuesRenderer.shadowRoot?.textContent ?? "").toContain("LLM Opinion"),
			);
			await waitFor(() =>
				expect(noIssuesRenderer.shadowRoot?.textContent ?? "").toContain(
					"The revised poem is ready to publish.",
				),
			);
			expect(document.querySelector("[data-warning-code]")).toBeNull();
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("shows inline poem renderer warnings without erasing neighboring poem history", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;
		const extensionCatalog = await createRealSinglePromptCatalog();

		try {
			const instanceIdRef = { value: "" };
			harness = await setupMountedUiHarness({
				extensionCatalog,
				configureConfig: configurePoemModel,
				route: () => `/processes/${instanceIdRef.value}`,
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "poem_creator_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "CHRON-P5-WARN",
						paramsJson: JSON.stringify({
							prompt: "Write a short poem about release trains crossing Berlin.",
						}),
					});
					instanceIdRef.value = process.id;

					for (const [turnRecordId, leafEntryId, markdown] of [
						[
							"trn_poem_valid",
							"assistant-poem-valid",
							"# Quiet Platform\n\nMorning rails glint<br>Small deploys begin",
						],
						[
							"trn_poem_invalid",
							"assistant-poem-invalid",
							"# Broken Platform\n\nFallback markdown still survives",
						],
					] as const) {
						createAcceptedLlmTurn(testApp, {
							id: turnRecordId,
							instanceId: process.id,
							turnId: "draft_poem",
							turnType: "llm",
							status: "succeeded",
							pathType: "primary",
							forkPiEntryId: null,
							resultPiEntryId: leafEntryId,
							turnResultMarkdown: markdown,
							errorSummary: null,
							startedAt: "2026-04-18T16:00:00.000Z",
							endedAt: "2026-04-18T16:00:04.000Z",
						});
						testApp.ctx.deps.events.create({
							instanceId: process.id,
							eventType: "turn_outcome_recorded",
							data: {
								turnRecordId,
								turnId: "draft_poem",
								outcome: "draft_ready",
								params: {},
							},
						});
					}

					testApp.ctx.deps.leafOutcomeSnapshots.create({
						instanceId: process.id,
						leafEntryId: "assistant-poem-valid",
						turnRecordId: "trn_poem_valid",
						rendererId: "@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome",
						schemaVersion: 1,
						props: buildPoemLeafOutcomePayload({
							prompt: "Write a short poem about release trains crossing Berlin.",
							markdown: "# Quiet Platform\n\nMorning rails glint<br>Small deploys begin",
						}),
						fallbackMarkdown: "# Quiet Platform\n\nMorning rails glint<br>Small deploys begin",
						status: "ready",
						anchoredAt: "2026-04-18T16:00:04.000Z",
					});
					testApp.ctx.deps.leafOutcomeSnapshots.create({
						instanceId: process.id,
						leafEntryId: "assistant-poem-invalid",
						turnRecordId: "trn_poem_invalid",
						rendererId: "@leitwerk-dev/showcase-processes:poem_creator_process.leaf_outcome",
						schemaVersion: 99,
						props: buildPoemLeafOutcomePayload({
							prompt: "Write a short poem about release trains crossing Berlin.",
							markdown: "# Broken Platform\n\nFallback markdown still survives",
						}),
						fallbackMarkdown: "# Broken Platform\n\nFallback markdown still survives",
						status: "ready",
						anchoredAt: "2026-04-18T16:05:04.000Z",
					});
				},
			});

			await waitFor(() =>
				expect(document.querySelectorAll("o2-showcase-processes-poem-outcome").length).toBe(1),
			);
			await waitFor(() =>
				expect(
					document.querySelector('[data-warning-code="unsupported_schema_version"]'),
				).not.toBeNull(),
			);
			const validPoem = document.querySelector(
				"o2-showcase-processes-poem-outcome",
			) as HTMLElement & {
				shadowRoot: ShadowRoot | null;
			};
			await waitFor(() =>
				expect(validPoem.shadowRoot?.textContent ?? "").toContain("Quiet Platform"),
			);
			await waitFor(() =>
				expect(document.body.textContent).toContain("Fallback markdown still survives"),
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
