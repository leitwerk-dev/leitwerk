import { ADMIN_ACTOR, SYSTEM_ACTOR, TELEGRAM_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { getProcessGraph } from "./process-graph.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor as createFakeSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
// Ensure the jira fixture graph is registered for the engine under test.
getProcessGraph(processGraphs, "jira_issue_process");

function createEngine(
	deps: ReturnType<typeof createTestDeps>,
	options: { processActionRegistry?: ProcessActionRegistry } = {},
) {
	return createProcessEngine({
		...deps,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => createFakeSupervisor(),
		processGraphs,
		...(options.processActionRegistry
			? { getProcessActionRegistry: () => options.processActionRegistry }
			: {}),
	});
}

function createAttributionActionRegistry(): ProcessActionRegistry {
	const action = {
		id: "record_decision",
		label: "Record decision",
		async plan() {},
	};
	return {
		getAction: () => action,
		isTurnScopedAction: () => false,
		listVisibleActions: () => [
			{ id: action.id, label: action.label, description: null, preview: null },
		],
		resolveContextData: () => ({ params: {}, state: {} }),
		resolveTurnScopedAction: () => null,
		getSelectedTurnSummary: () => null,
		getServerDefinition: () => undefined,
		getTurnDefinition: () => undefined,
		getProcessGraph: () => undefined,
		getProcessDisplayName: () => undefined,
		resolveActionPreview: () => null,
		resolveActionScheduling: () => null,
	};
}

describe("actor attribution on queued inputs", () => {
	it("stamps the resolved actor onto queued inputs that lack one", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createEngine(deps);

		const result = await commands.queueInputs(
			process.id,
			[{ source: "app_steer", kind: "instruction", bodyMarkdown: "Revise" }],
			{ actor: ADMIN_ACTOR },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]?.actor).toEqual(ADMIN_ACTOR);
		expect(deps.inputs.listByInstance(process.id)[0]?.actor).toEqual(ADMIN_ACTOR);
	});

	it("preserves a per-input actor over the command-level default", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createEngine(deps);

		const result = await commands.queueInputs(
			process.id,
			[
				{
					source: "external_comment",
					kind: "instruction",
					bodyMarkdown: "From telegram",
					actor: TELEGRAM_ACTOR,
				},
			],
			{ actor: ADMIN_ACTOR },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]?.actor).toEqual(TELEGRAM_ACTOR);
	});

	it("defaults to the system actor when no actor is supplied", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createEngine(deps);

		const result = await commands.queueInputs(process.id, [
			{ source: "watcher_event", kind: "instruction", bodyMarkdown: "Reconcile" },
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]?.actor).toEqual(SYSTEM_ACTOR);
	});
});

describe("actor attribution on lifecycle events", () => {
	function createFailedImplementProcess(deps: ReturnType<typeof createTestDeps>) {
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
		});
		deps.turnRecords.create({
			id: "trn_impl_1",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});
		return process;
	}

	it("attributes start turn selection events to system for internal callers", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		const commands = createEngine(deps);

		const result = await commands.startProcess(process.id, "generate_plan");

		expect(result.ok).toBe(true);
		const startEvent = deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "turn_selected");
		expect(startEvent?.data.actor).toEqual(SYSTEM_ACTOR);
	});

	it("stamps the actor into the persisted retry_scheduled event data", async () => {
		const deps = createTestDeps();
		const process = createFailedImplementProcess(deps);
		const commands = createEngine(deps);

		const result = await commands.retryProcess(process.id, { actor: ADMIN_ACTOR });

		expect(result.ok).toBe(true);
		const retryEvent = deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "retry_scheduled");
		expect(retryEvent?.data.actor).toEqual(ADMIN_ACTOR);
	});

	it("attributes retry_scheduled event data to system for internal callers", async () => {
		const deps = createTestDeps();
		const process = createFailedImplementProcess(deps);
		const commands = createEngine(deps);

		const result = await commands.retryProcess(process.id);

		expect(result.ok).toBe(true);
		const retryEvent = deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "retry_scheduled");
		expect(retryEvent?.data.actor).toEqual(SYSTEM_ACTOR);
	});

	it("stamps the actor into the abort turn_selected event and emits no duplicate process_aborted", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createEngine(deps);

		const result = await commands.abortProcess(process.id, { actor: TELEGRAM_ACTOR });

		expect(result.ok).toBe(true);
		const events = deps.events.listByInstance(process.id, 10);
		const selectionEvent = events.find((event) => event.eventType === "turn_selected");
		expect(selectionEvent?.data.actor).toEqual(TELEGRAM_ACTOR);
		// The selection event already records the abort, so no duplicate process_aborted
		// event (or its broadcast) is emitted on the common path.
		expect(events.some((event) => event.eventType === "process_aborted")).toBe(false);
	});

	it("records an attributed abort event when no turn selection changes", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		const commands = createEngine(deps);

		const result = await commands.abortProcess(process.id, { actor: ADMIN_ACTOR });

		expect(result.ok).toBe(true);
		const events = deps.events.listByInstance(process.id, 10);
		expect(events.some((event) => event.eventType === "turn_selected")).toBe(false);
		const abortEvent = events.find((event) => event.eventType === "process_aborted");
		expect(abortEvent?.data.actor).toEqual(ADMIN_ACTOR);
		expect(abortEvent?.data).toMatchObject({
			fromLifecycleStatus: "discovered",
			toLifecycleStatus: "aborted",
		});
	});

	it("stamps the actor into process action event data", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createEngine(deps, {
			processActionRegistry: createAttributionActionRegistry(),
		});

		const result = await commands.executeProcessAction(
			process.id,
			"record_decision",
			{},
			{ actor: ADMIN_ACTOR },
		);

		expect(result.ok).toBe(true);
		const actionEvent = deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "process_action_executed");
		expect(actionEvent?.data.actor).toEqual(ADMIN_ACTOR);
		expect(actionEvent?.data.actionId).toBe("record_decision");
	});

	it("does not persist submitted action field values in process action events", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createEngine(deps, {
			processActionRegistry: createAttributionActionRegistry(),
		});

		const result = await commands.executeProcessAction(
			process.id,
			"record_decision",
			{ decisionRationale: "sensitive form contents" },
			{ actor: ADMIN_ACTOR },
		);

		expect(result.ok).toBe(true);
		const actionEvent = deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "process_action_executed");
		expect(actionEvent?.data).not.toHaveProperty("submittedFields");
		expect(actionEvent?.data.actor).toEqual(ADMIN_ACTOR);
	});
});
