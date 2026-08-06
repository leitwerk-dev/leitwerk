import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	createDurableWsFrame,
	createEphemeralWsFrame,
	type PrimaryPathSnapshot,
	type ProcessDetailUiSnapshotResponseBody,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const extensionCatalog = buildExtensionCatalogFromModules([showcaseProcessesExtension]);

function click(element: Element) {
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createStalePrimaryPathSnapshot(instanceId: string): PrimaryPathSnapshot {
	return {
		instanceId,
		rebuiltAt: "2026-01-01T00:00:00.000Z",
		primaryPathEntries: [],
		currentLeaf: null,
		semanticEntryRefs: {
			plan: null,
			review: null,
			currentPrimaryPathLeaf: null,
			rootEntry: null,
		},
		labels: {},
		turnAnnotations: [],
		detailRail: {
			keyPoints: [],
			futureTurns: [],
			currentPosition: null,
		},
		turnState: {
			currentTurnRecordId: null,
			workerState: "busy",
			isStreaming: false,
			activeTurn: null,
		},
	};
}

function createStaleUiSnapshot(
	instanceId: string,
	overrides: Partial<ProcessDetailUiSnapshotResponseBody> = {},
): ProcessDetailUiSnapshotResponseBody {
	const timestamp = "2026-01-01T00:00:00.000Z";
	return {
		process: {
			id: instanceId,
			processId: "single_prompt_process",
			selectedTurnId: "run_single_prompt",
			lifecycleStatus: "active",
			currentExecution: null,
			planRevision: 0,
			title: null,
			externalId: null,
			externalUrl: null,
			metadata: null,
			defaultModelProfileId: null,
			turnConfigsJson: null,
			selectedTurnModelProfileId: null,
			paramsJson: null,
			stateJson: null,
			createdAt: timestamp,
			updatedAt: timestamp,
			closedAt: null,
		},
		projects: [],
		inputs: [],
		events: [],
		leafOutcomeSnapshots: [],
		turnRecords: [],
		turnAnnotations: [],
		workerLease: null,
		processDisplayName: "Single Prompt Process",
		processGraph: {
			id: "single_prompt_process",
			entryTurnIds: ["run_single_prompt"],
			reachableTurnIds: ["run_single_prompt"],
			turnTransitions: {},
		},
		processFlow: {
			processId: "single_prompt_process",
			entryTurnIds: ["run_single_prompt"],
			spine: ["run_single_prompt"],
			nodes: [
				{
					turnId: "run_single_prompt",
					description: "Run single prompt",
					turnType: "llm",
					role: "spine",
					spineIndex: 0,
					anchorTurnId: null,
					isEntry: true,
				},
			],
			edges: [],
			endStates: [],
		},
		piSessionEntries: [],
		definesLeafOutcome: false,
		selectedTurn: null,
		scheduledAction: null,
		modelConfiguration: {
			availableProfiles: [],
			effectiveSelectedTurn: null,
			defaultModel: {
				processConfigModelProfileId: null,
				instanceModelProfileId: null,
				effectiveModelProfileId: null,
				source: "none",
			},
			turns: [],
		},
		runDetails: {
			systemPrompt: null,
			appendSystemPrompt: null,
			availablePiToolNames: [],
			turns: [],
		},
		launchConfiguration: {
			launcherId: null,
			launcherLabel: null,
			launcherSchemaTitle: null,
			paramsParseError: null,
			parameters: [],
			projects: [],
		},
		actions: [],
		toolRenderers: [],
		primaryPath: {
			...createStalePrimaryPathSnapshot(instanceId),
			entryCount: 0,
			entriesOmitted: true,
		},
		timeline: {
			prompt: { text: null, createdAt: null, preview: null },
			turns: [],
			tracePreviewsByTurnRecordId: {},
			inputs: [],
			externalTriggerSignals: [],
			usageByTurnRecordId: {},
		},
		instanceTree: { currentLeafId: null, nodes: [], edges: [] },
		recovery: null,
		processError: null,
		usageEstimate: null,
		persistedModelSelectionWarning: null,
		hasSessionFile: false,
		session: { signature: null },
		...overrides,
	};
}

describe("live websocket launch races", () => {
	it("refreshes the authoritative sidebar overview after a process is created", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: "/",
			});

			await waitFor(() => expect(document.querySelector('[data-page="home"]')).not.toBeNull());
			// The premise is a *live* websocket launch: the durable process.created
			// frame is delivered, not replayed. The server broadcaster only sends to
			// OPEN clients, so wait for the UI socket to connect before broadcasting,
			// otherwise the frame is dropped before the client registers.
			await waitFor(() => expect(harness?.socketObserver.hasOpenSocket()).toBe(true));
			const initialListFetchCount = harness.fetchHarness.count("/api/processes/overview");

			const process = harness.testApp.ctx.deps.processes.create({
				processId: "single_prompt_process",
				selectedTurnId: null,
				lifecycleStatus: "discovered",
				title: "Sidebar insert",
			});
			harness.testApp.ctx.broadcaster.broadcast(
				createDurableWsFrame({
					type: "process.created",
					instanceId: process.id,
					payload: {
						process,
						processId: process.processId,
					},
				}),
			);

			await waitFor(() => {
				const link = document.querySelector(`a[href="/processes/${process.id}"]`);
				expect(link).not.toBeNull();
				return link;
			});
			expect(harness.fetchHarness.count("/api/processes/overview")).toBe(initialListFetchCount + 1);
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("replays buffered primary-path frames after the initial detail snapshot resolves", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: "/",
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: null,
						lifecycleStatus: "discovered",
						title: "Buffered detail replay",
					});
					instanceId = process.id;
				},
			});

			await waitFor(() => expect(document.querySelector('[data-page="home"]')).not.toBeNull());
			await waitFor(() => expect(harness?.socketObserver.hasOpenSocket()).toBe(true));
			const process = harness.testApp.ctx.deps.processes.getById(instanceId);
			expect(process).not.toBeNull();
			if (!process) {
				throw new Error("expected seeded process");
			}

			const setupFrameCount = harness.socketObserver.getReceivedCount();
			harness.testApp.ctx.broadcaster.broadcast(
				createDurableWsFrame({
					type: "process.created",
					instanceId,
					payload: {
						process,
						processId: process.processId,
					},
				}),
			);
			harness.testApp.ctx.deps.processes.update(instanceId, {
				selectedTurnId: "run_single_prompt",
				lifecycleStatus: "active",
			});
			harness.testApp.ctx.broadcaster.broadcast(
				createDurableWsFrame({
					type: "process.updated",
					instanceId,
					payload: {
						process: {
							selectedTurnId: "run_single_prompt",
							lifecycleStatus: "active",
						},
						changedFields: ["selectedTurnId", "lifecycleStatus"],
					},
				}),
			);
			await waitFor(() =>
				expect(harness?.socketObserver.getReceivedCount()).toBeGreaterThanOrEqual(
					setupFrameCount + 2,
				),
			);

			const deferredUiSnapshot = createDeferred<Response>();
			harness.fetchHarness.respondNext(
				`/api/processes/${instanceId}/ui-snapshot`,
				deferredUiSnapshot.promise,
			);

			const rowLink = await waitFor(() => {
				const link = document.querySelector(`a[href="/processes/${instanceId}"]`);
				expect(link).not.toBeNull();
				return link as HTMLAnchorElement;
			});
			click(rowLink);

			await waitFor(() => expect(window.location.pathname).toBe(`/processes/${instanceId}`));
			await waitFor(() =>
				expect(harness?.fetchHarness.count(`/api/processes/${instanceId}/ui-snapshot`)).toBe(1),
			);

			const receivedFrameCount = harness.socketObserver.getReceivedCount();
			harness.testApp.ctx.broadcaster.broadcast(
				createDurableWsFrame({
					type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
					instanceId,
					payload: {
						turnRecord: {
							id: "trn_buffered_live",
							instanceId,
							turnId: "run_single_prompt",
							turnType: "llm",
							status: "running",
							attemptNumber: 1,
							parentTurnRecordId: null,
							turnStartRecordId: "tsr_buffered_live",
							acceptedWorkerLeaseId: "wls_buffered_live",
							pathType: "primary",
							forkPiEntryId: null,
							resultPiEntryId: null,
							modelProfileId: null,
							turnResultMarkdown: null,
							errorSummary: null,
							errorClass: null,
							startedAt: "2026-01-01T00:00:02.000Z",
							endedAt: null,
						},
					},
					sentAt: "2026-01-01T00:00:02.000Z",
				}),
			);
			harness.testApp.ctx.broadcaster.broadcast(
				createEphemeralWsFrame({
					type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
					instanceId,
					payload: {
						turnRecordId: "trn_buffered_live",
						piTurnId: "turn-1",
						text: "buffered live text",
						streamType: "text",
						timestamp: "2026-01-01T00:00:03.000Z",
					},
					sentAt: "2026-01-01T00:00:03.000Z",
				}),
			);

			// The premise of this case is that both websocket frames have reached
			// the client-side pending-detail buffer before the HTTP snapshot wins.
			await waitFor(() =>
				expect(harness?.socketObserver.getReceivedCount()).toBeGreaterThanOrEqual(
					receivedFrameCount + 2,
				),
			);
			deferredUiSnapshot.resolve(
				new Response(JSON.stringify(createStaleUiSnapshot(instanceId)), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

			await waitFor(() => {
				const liveTail = document.querySelector('[data-section="live-tail"]');
				expect(liveTail).not.toBeNull();
				expect(liveTail?.textContent ?? "").toContain("buffered live text");
			});
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});

	it("retries the pending detail load once live-turn metadata arrives", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;

		try {
			let instanceId = "";
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: "/",
				async prepare(testApp) {
					const process = testApp.ctx.deps.processes.create({
						processId: "single_prompt_process",
						selectedTurnId: "run_single_prompt",
						lifecycleStatus: "active",
						title: "Pending detail load",
					});
					instanceId = process.id;
					testApp.ctx.broadcaster.broadcast(
						createDurableWsFrame({
							type: "process.created",
							instanceId,
							payload: {
								process,
								processId: process.processId,
							},
						}),
					);
				},
			});

			const deferredUiSnapshot = createDeferred<Response>();
			harness.fetchHarness.respondNext(
				`/api/processes/${instanceId}/ui-snapshot`,
				deferredUiSnapshot.promise,
			);
			const rowLink = await waitFor(() => {
				const link = document.querySelector(`a[href="/processes/${instanceId}"]`);
				expect(link).not.toBeNull();
				return link as HTMLAnchorElement;
			});
			click(rowLink);

			await waitFor(() =>
				expect(harness?.fetchHarness.count(`/api/processes/${instanceId}/ui-snapshot`)).toBe(1),
			);
			expect(harness.fetchHarness.count(`/api/processes/${instanceId}/ui-snapshot`)).toBe(1);

			const lease = harness.testApp.ctx.deps.leases.create({
				instanceId,
				workerId: "wkr_reload_guard",
				state: "busy",
			});
			const start = harness.testApp.ctx.deps.turnStarts.create({
				id: "tsr_reload_guard",
				instanceId,
				turnId: "run_single_prompt",
				turnType: "llm",
				proposedTurnRecordId: "trn_reload_guard",
				startKind: "selected_turn",
				recoveryTurnRecordId: null,
				continuation: null,
				state: {
					kind: "accepted",
					start: {
						kind: "llm",
						model: {
							profileId: "fixture",
							providerId: "fixture",
							modelId: "fixture",
							thinkingLevel: "off",
						},
						providerOptions: {},
						providerWorkerConfig: null,
						piResourceSnapshotDigest: "fixture-digest",
						workerRuntimeProfileId: "local",
						piSettings: {},
					},
					turnRecordId: "trn_reload_guard",
					acceptedWorkerLeaseId: lease.id,
				},
			});
			harness.testApp.ctx.deps.turnRecords.create({
				id: "trn_reload_guard",
				instanceId,
				turnId: "run_single_prompt",
				turnType: "llm",
				status: "running",
				turnStartRecordId: start.id,
				acceptedWorkerLeaseId: lease.id,
				pathType: "primary",
				startedAt: "2026-01-01T00:00:01.000Z",
			});
			harness.testApp.ctx.deps.processes.update(instanceId, {
				currentExecution: { kind: "worker_start", id: start.id },
			});
			harness.testApp.ctx.deps.events.create({
				instanceId,
				eventType: "pi.stream.delta",
				data: {
					turnRecordId: "trn_reload_guard",
					turnId: "turn-guard",
					streamType: "text",
					text: "live turn after retry",
					timestamp: "2026-01-01T00:00:02.000Z",
				},
			});
			harness.testApp.ctx.broadcaster.broadcast(
				createDurableWsFrame({
					type: "process.updated",
					instanceId,
					payload: {
						process: { currentExecution: { kind: "worker_start", id: start.id } },
						changedFields: ["currentExecution"],
					},
				}),
			);
			harness.testApp.ctx.broadcaster.broadcast(
				createDurableWsFrame({
					type: "process.event",
					instanceId,
					payload: {
						eventType: "turn_started",
						level: "info",
						message: "turn started",
					},
				}),
			);

			await waitFor(() =>
				expect(harness.fetchHarness.count(`/api/processes/${instanceId}/ui-snapshot`)).toBe(2),
			);

			deferredUiSnapshot.resolve(
				new Response(JSON.stringify(createStaleUiSnapshot(instanceId)), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			await waitFor(() => {
				const liveTail = document.querySelector('[data-section="live-tail"]');
				expect(liveTail).not.toBeNull();
				expect(liveTail?.textContent ?? "").toContain("live turn after retry");
			});
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
