import type { ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { emptyPollResult } from "./poll-loop.js";
import {
	continueWatcherAgentStartup,
	requireWatcherStartTurnId,
	runWatcherAbortReconciliation,
	runWatcherCompletionReconciliation,
	runWatcherDiscoveryPass,
} from "./watcher-coordinator.js";

function makeProcess(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return {
		id: "agt_1",
		processId: "jira_issue_process",
		selectedTurnId: null,
		lifecycleStatus: "discovered",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		modelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function createEventRepo() {
	const events: Array<{
		instanceId: string;
		eventType: string;
		data?: Record<string, unknown>;
	}> = [];
	return {
		create(input: { instanceId: string; eventType: string; data?: Record<string, unknown> }) {
			events.push(input);
		},
		listByInstance(instanceId: string, _limit?: number) {
			return events.filter((event) => event.instanceId === instanceId);
		},
		all() {
			return events;
		},
	};
}

function createExternalWrites() {
	const writes: Array<{
		instanceId: string;
		dedupKey: string;
		metadata?: Record<string, unknown>;
	}> = [];
	return {
		hasDedupKey(dedupKey: string) {
			return writes.some((write) => write.dedupKey === dedupKey);
		},
		record(input: { instanceId: string; dedupKey: string; metadata?: Record<string, unknown> }) {
			writes.push(input);
		},
		all() {
			return writes;
		},
	};
}

function createStartupHarness(process: ProcessInstance) {
	const events = createEventRepo();
	const processes = new Map([[process.id, process]]);
	const broadcasts: Array<{ type: string; payload: unknown; instanceId?: string }> = [];
	const workers = new Set<string>();

	return {
		events,
		broadcasts,
		workers,
		deps: {
			processes: {
				getById(id: string) {
					return processes.get(id) ?? null;
				},
			},
			broadcaster: {
				sendDurable(type: string, payload: unknown, instanceId?: string) {
					broadcasts.push({ type, payload, instanceId });
				},
			},
			events,
			commands: {
				async startProcess(instanceId: string, startTurnId: string) {
					const current = processes.get(instanceId);
					if (!current) {
						return { ok: false, code: "not_found", message: "missing" } as const;
					}
					const updated = {
						...current,
						selectedTurnId: startTurnId,
						lifecycleStatus: "active" as const,
					};
					processes.set(instanceId, updated);
					return { ok: true, process: updated } as const;
				},
				async abortProcess() {
					return { ok: true, process: null } as const;
				},
			},
			supervisor: {
				async spawnWorker(instanceId: string) {
					workers.add(instanceId);
					return { instanceId };
				},
				getWorker(instanceId: string) {
					return workers.has(instanceId) ? { instanceId } : undefined;
				},
			},
		},
	};
}

function createStartupRequest(process: ProcessInstance) {
	return {
		process,
		startTurnId: "generate_plan",
		createdEventData: process.externalId ? { jiraIssueKey: process.externalId } : {},
		createdBroadcastData: process.externalId ? { jiraIssueKey: process.externalId } : {},
	};
}

describe("watcher-coordinator", () => {
	it("requires a watcher launch start turn id", () => {
		expect(
			requireWatcherStartTurnId(
				{ launcherId: "jira.launcher", startTurnId: "generate_plan" },
				"issue CLD-1",
			),
		).toBe("generate_plan");
		expect(() =>
			requireWatcherStartTurnId({ launcherId: "jira.launcher", startTurnId: null }, "issue CLD-1"),
		).toThrowError(
			"Watcher launcher 'jira.launcher' did not declare a startTurnId for issue CLD-1",
		);
	});

	it("continues startup by creating event, starting process, broadcasting, and ensuring worker", async () => {
		const process = makeProcess({ externalId: "CLD-1" });
		const harness = createStartupHarness(process);

		const instanceId = await continueWatcherAgentStartup(
			harness.deps,
			createStartupRequest(process),
		);

		expect(instanceId).toBe(process.id);
		expect(harness.events.all().map((event) => event.eventType)).toContain("agent_created");
		expect(harness.broadcasts.map((broadcast) => broadcast.type)).toContain("process.created");
		expect(harness.workers.has(process.id)).toBe(true);
	});

	it("throws when starting the discovered process fails", async () => {
		const process = makeProcess({ externalId: "CLD-2" });
		const harness = createStartupHarness(process);

		await expect(
			continueWatcherAgentStartup(
				{
					...harness.deps,
					commands: {
						async startProcess() {
							return {
								ok: false as const,
								code: "invalid_model_profile" as const,
								message: "turn model is not allowed",
							};
						},
						async abortProcess() {
							return { ok: true, process: null } as const;
						},
					},
					supervisor: {
						async spawnWorker() {
							throw new Error("spawnWorker should not be called");
						},
						getWorker() {
							return undefined;
						},
					},
				},
				createStartupRequest(process),
			),
		).rejects.toThrow("turn model is not allowed");
	});

	it("does not try to spawn a worker when an active process has no selected turn", async () => {
		const process = makeProcess({
			id: "agt_no_turn",
			selectedTurnId: null,
			lifecycleStatus: "active",
		});
		const harness = createStartupHarness(process);

		await continueWatcherAgentStartup(harness.deps, createStartupRequest(process));

		expect(harness.workers.size).toBe(0);
	});

	it("discovery pass handles create, resume, respawn, and skip branches", async () => {
		const result = emptyPollResult();
		const resumed: string[] = [];
		const respawned: string[] = [];
		const created: string[] = [];
		const discoveredAgent = makeProcess({
			id: "agt_d",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			externalId: "DISCOVERED",
		});
		const activeAgent = makeProcess({
			id: "agt_a",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			externalId: "ACTIVE",
		});
		const idleAgent = makeProcess({
			id: "agt_i",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			externalId: "IDLE",
		});

		await runWatcherDiscoveryPass({
			items: ["DISCOVERED", "ACTIVE", "IDLE", "NEW"],
			result,
			findExistingAgent(item) {
				if (item === "DISCOVERED") return discoveredAgent;
				if (item === "ACTIVE") return activeAgent;
				if (item === "IDLE") return idleAgent;
				return null;
			},
			getResultLabel: (item) => item,
			async resumeDiscoveredAgent(process, item) {
				resumed.push(`${process.id}:${item}`);
			},
			async createAgent(item) {
				created.push(item);
				return item === "NEW" ? { outcome: "created" as const, instanceId: "agt_new" } : null;
			},
			async ensureWorkerForExistingAgent(process, item) {
				if (item !== "ACTIVE") {
					return false;
				}
				respawned.push(process.id);
				return true;
			},
			formatError: (item, error) => `${item}: ${String(error)}`,
		});

		expect(resumed).toEqual(["agt_d:DISCOVERED"]);
		expect(respawned).toEqual(["agt_a"]);
		expect(created).toEqual(["NEW"]);
		expect(result.created).toEqual(["NEW"]);
		expect(result.skipped).toEqual(["IDLE"]);
		expect(result.errors).toEqual([]);
	});

	it("abort reconciliation aborts matching processes and only emits the event once", async () => {
		const result = emptyPollResult();
		const events = createEventRepo();
		const process = makeProcess({
			id: "agt_abort",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			externalId: "CLD-2",
		});
		let abortCount = 0;
		const commands = {
			async startProcess() {
				return { ok: true, process } as const;
			},
			async abortProcess() {
				abortCount += 1;
				return {
					ok: true,
					process: { ...process, selectedTurnId: null, lifecycleStatus: "aborted" as const },
				} as const;
			},
		};
		const reconciliation = {
			candidates: [process],
			result,
			events,
			commands,
			shouldAbort: async () => true,
			getResultLabel: (candidate: ProcessInstance) => candidate.externalId ?? candidate.id,
			getErrorLabel: (candidate: ProcessInstance) => candidate.externalId ?? candidate.id,
			getAbortedEventData: () => ({ jiraIssueKey: "CLD-2" }),
		};

		await runWatcherAbortReconciliation(reconciliation);
		await runWatcherAbortReconciliation({ ...reconciliation, result: emptyPollResult() });

		expect(abortCount).toBe(2);
		expect(result.aborted).toEqual(["CLD-2"]);
		expect(
			events.all().filter((event) => event.eventType === "aborted_label_removed"),
		).toHaveLength(1);
	});

	it("completion reconciliation records label exchanges and isolates errors", async () => {
		const result = emptyPollResult();
		const externalWrites = createExternalWrites();
		const completed = makeProcess({
			id: "agt_complete",
			selectedTurnId: null,
			lifecycleStatus: "completed",
			externalId: "CLD-3",
		});
		const failing = makeProcess({
			id: "agt_fail",
			selectedTurnId: null,
			lifecycleStatus: "completed",
			externalId: "CLD-4",
		});

		await runWatcherCompletionReconciliation({
			candidates: [completed, failing],
			result,
			externalWrites,
			async reconcile(process) {
				if (process.id === "agt_fail") {
					throw new Error("label unavailable");
				}
				return {
					changed: true,
					writeIdentity: {
						writeType: "jira.label_exchange.complete",
						dedupKey: `${process.id}:complete`,
					},
					metadata: { jiraIssueKey: process.externalId },
				};
			},
			getResultLabel: (process) => process.externalId ?? process.id,
			getErrorLabel: (process) => process.externalId ?? process.id,
		});

		expect(result.labelExchanged).toEqual(["CLD-3"]);
		expect(result.errors).toEqual(["CLD-4: label unavailable"]);
		expect(externalWrites.all()).toHaveLength(1);
		expect(externalWrites.all()[0]?.dedupKey).toBe("agt_complete:complete");
	});
});
