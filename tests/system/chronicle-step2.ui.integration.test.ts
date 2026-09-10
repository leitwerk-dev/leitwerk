import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { writeProcessSessionSnapshot } from "@leitwerk-dev/server/testing";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const extensionCatalog = buildExtensionCatalogFromModules([singlePromptExtension]);
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

function click(element: Element) {
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function scroll(element: HTMLElement, top: number) {
	element.scrollTop = top;
	element.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function setLayoutMetric(element: Element, key: "offsetTop" | "offsetHeight", value: number) {
	Object.defineProperty(element, key, {
		configurable: true,
		get: () => value,
	});
}

function setViewportMetric(element: Element, key: "clientHeight" | "scrollHeight", value: number) {
	Object.defineProperty(element, key, {
		configurable: true,
		get: () => value,
	});
}

describe("chronicle step 2 experience", () => {
	it("renders structured chronicle sections and shows operator input without raw tool JSON dumps", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${instanceId}`,
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "CHRON-P2-1",
					});
					instanceId = process.id;

					testApp.ctx.deps.inputs.create({
						instanceId: process.id,
						sequence: 1,
						source: "app_steer",
						kind: "instruction",
						bodyMarkdown: "Please tighten the final line.",
					});

					createAcceptedLlmTurn(testApp, {
						id: "trn_done",
						instanceId: process.id,
						turnId: "run_single_prompt",
						turnType: "llm",
						status: "succeeded",
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: "assistant-final",
						turnResultMarkdown: "## Final answer\n\nDone.",
						errorSummary: null,
						startedAt: "2026-04-18T10:00:00.000Z",
						endedAt: "2026-04-18T10:00:04.000Z",
					});

					await writeProcessSessionSnapshot(testApp.ctx, process.id, [
						{
							type: "session",
							version: 3,
							id: `sess_${process.id}`,
							timestamp: "2026-04-18T10:00:00.000Z",
							cwd: "/tmp/project",
						},
						{
							type: "message",
							id: "root-user",
							parentId: null,
							timestamp: "2026-04-18T10:00:00.000Z",
							message: {
								role: "user",
								content: "Write a short answer",
							},
						},
						{
							type: "message",
							id: "assistant-tool",
							parentId: "root-user",
							timestamp: "2026-04-18T10:00:01.000Z",
							message: {
								role: "assistant",
								content: [
									{ type: "thinking", thinking: "Need to inspect the repo.\n" },
									{
										type: "toolCall",
										id: "tool_readme",
										name: "read",
										arguments: { path: "README.md" },
									},
								],
							},
						},
						{
							type: "message",
							id: "tool-result",
							parentId: "assistant-tool",
							timestamp: "2026-04-18T10:00:03.000Z",
							message: {
								role: "toolResult",
								toolCallId: "tool_readme",
								toolName: "read",
								content: [{ type: "text", text: "README summary" }],
								details: { bytes: 128 },
								isError: false,
							},
						},
						{
							type: "message",
							id: "assistant-final",
							parentId: "tool-result",
							timestamp: "2026-04-18T10:00:04.000Z",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "Done." }],
							},
						},
					]);

					testApp.ctx.deps.events.create({
						instanceId: process.id,
						eventType: "turn_outcome_recorded",
						data: {
							turnRecordId: "trn_done",
							turnId: "run_single_prompt",
							outcome: "completed",
							params: {},
						},
					});
				},
			});

			await waitFor(() =>
				expect(document.querySelector('[data-page="process-detail"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector('[data-section="operator-input"][data-input-source="app_steer"]'),
				).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector('[data-section="chronicle-turn"][data-turn-record-id="trn_done"]'),
				).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="chronicle-turn"][data-turn-record-id="trn_done"] [data-section="thinking-preview"]',
					),
				).toBeNull(),
			);
			const reasoningDetailsButton = await waitFor(() => {
				const button = document.querySelector(
					'[data-section="chronicle-turn"][data-turn-record-id="trn_done"] .footer-actions [data-action="open-reasoning-details"]',
				);
				expect(button).not.toBeNull();
				return button as HTMLButtonElement;
			});
			click(reasoningDetailsButton);
			await waitFor(() =>
				expect(document.querySelector('[data-section="reasoning-details-overlay"]')).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="reasoning-details-overlay"] [data-section="reasoning-tool-marker"][data-tool-name="read"]',
					),
				).not.toBeNull(),
			);
			expect(
				document.querySelector(
					'[data-section="chronicle-turn"][data-turn-record-id="trn_done"] [data-section="assistant-output"]',
				),
			).toBeNull();
			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="chronicle-turn"][data-turn-record-id="trn_done"] [data-section="turn-result"]',
					),
				).not.toBeNull(),
			);
			await waitFor(() =>
				expect(document.body.textContent).toContain("Please tighten the final line."),
			);

			expect(document.body.textContent).not.toContain('"path": "README.md"');
			expect(document.body.textContent).not.toContain('"bytes": 128');
			expect(document.body.textContent).not.toContain("1 action interleaved");
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("keeps Turn Rail state tied to the chronicle scroll position and jumps immediately on rail clicks", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${instanceId}`,
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: null,
						lifecycleStatus: "completed",
						externalId: "CHRON-P2-2",
					});
					instanceId = process.id;

					for (const [index, id] of ["trn_one", "trn_two", "trn_three"].entries()) {
						createAcceptedLlmTurn(testApp, {
							id,
							instanceId: process.id,
							turnId: `run_single_prompt_${index + 1}`,
							turnType: "llm",
							status: "succeeded",
							pathType: "primary",
							forkPiEntryId: null,
							resultPiEntryId: null,
							turnResultMarkdown: null,
							errorSummary: null,
							startedAt: `2026-04-18T10:0${index}:00.000Z`,
							endedAt: `2026-04-18T10:0${index}:30.000Z`,
						});
						testApp.ctx.deps.events.create({
							instanceId: process.id,
							eventType: "turn_outcome_recorded",
							data: {
								turnRecordId: id,
								turnId: `run_single_prompt_${index + 1}`,
								outcome: "completed",
								params: { summary: `Completed ${index + 1}` },
							},
						});
					}
				},
			});

			const scrollViewport = await waitFor(() => {
				const viewport = document.querySelector('[data-role="chronicle-scroll"]');
				expect(viewport).not.toBeNull();
				return viewport as HTMLDivElement;
			});
			const chronicleTurns = await waitFor(() => {
				const elements = [
					...document.querySelectorAll<HTMLElement>('[data-section="chronicle-turn"]'),
				];
				expect(elements).toHaveLength(3);
				return elements;
			});
			setViewportMetric(scrollViewport, "clientHeight", 240);
			setViewportMetric(scrollViewport, "scrollHeight", 1_260);
			setLayoutMetric(chronicleTurns[0], "offsetTop", 0);
			setLayoutMetric(chronicleTurns[0], "offsetHeight", 220);
			setLayoutMetric(chronicleTurns[1], "offsetTop", 480);
			setLayoutMetric(chronicleTurns[1], "offsetHeight", 220);
			setLayoutMetric(chronicleTurns[2], "offsetTop", 960);
			setLayoutMetric(chronicleTurns[2], "offsetHeight", 220);

			scroll(scrollViewport, 420);
			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="turn-rail-list"] [data-turn-record-id="trn_two"][data-active="true"]',
					),
				).not.toBeNull(),
			);

			const thirdRailItem = await waitFor(() => {
				const button = document.querySelector(
					'[data-section="turn-rail-list"] [data-turn-record-id="trn_three"]',
				);
				expect(button).not.toBeNull();
				return button as HTMLButtonElement;
			});
			click(thirdRailItem);
			expect(scrollViewport.scrollTop).toBeCloseTo(960 - 28);

			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="turn-rail-list"] [data-turn-record-id="trn_three"][data-active="true"]',
					),
				).not.toBeNull(),
			);
			await waitFor(() =>
				expect(
					document.querySelector(
						'[data-section="chronicle-turn"][data-turn-record-id="trn_three"][data-focused="true"]',
					),
				).not.toBeNull(),
			);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
