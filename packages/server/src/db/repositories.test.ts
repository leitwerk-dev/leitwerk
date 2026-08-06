import { beforeEach, describe, expect, it } from "vitest";
import { MAX_PROCESS_TITLE_LENGTH } from "../launch-title.js";
import { createInMemoryDatabase, type LeitwerkDb } from "./database.js";
import {
	createExternalWriteLogRepo,
	createFutureExecutionRepo,
	createProcessEventRepo,
	createProcessInputRepo,
	createProcessInstanceRepo,
	createProcessLeafOutcomeSnapshotRepo,
	createProcessProjectRepo,
	createProcessTitleJobRepo,
	createProcessTurnAnnotationRepo,
	createProcessTurnRecordRepo,
	createWorkerLeaseRepo,
} from "./repositories.js";

let db: LeitwerkDb;

beforeEach(() => {
	db = createInMemoryDatabase();
});

describe("ProcessInstanceRepo", () => {
	it("creates and retrieves an process instance", () => {
		const repo = createProcessInstanceRepo(db);
		const process = repo.create({ processId: "jira_issue_process", lifecycleStatus: "discovered" });

		expect(process.id).toMatch(/^agt_/);
		expect(process.processId).toBe("jira_issue_process");
		expect(process.lifecycleStatus).toBe("discovered");
		expect(process.planRevision).toBe(0);

		const fetched = repo.getById(process.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.id).toBe(process.id);
	});

	it("returns null for missing process", () => {
		const repo = createProcessInstanceRepo(db);
		expect(repo.getById("nonexistent")).toBeNull();
	});

	it("persists a normalized explicit process title on create and update", () => {
		const repo = createProcessInstanceRepo(db);
		const process = repo.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
			title: "  Initial\n title  ",
		});

		expect(process.title).toBe("Initial title");
		expect(repo.getById(process.id)?.title).toBe("Initial title");

		const updated = repo.update(process.id, {
			title:
				"Updated process title that keeps rambling far beyond what should be shown in compact operator-facing list views",
		});
		expect(updated?.title?.length).toBeLessThanOrEqual(MAX_PROCESS_TITLE_LENGTH);
		expect(updated?.title).not.toMatch(/^\s|\s$/);
		expect(repo.getById(process.id)?.title).toBe(updated?.title);
	});

	it("updates a generated title only while the process title is still blank", () => {
		const repo = createProcessInstanceRepo(db);
		const process = repo.create({ processId: "jira_issue_process", lifecycleStatus: "discovered" });

		expect(repo.setGeneratedTitleIfBlank(process.id, "Generated title")?.title).toBe(
			"Generated title",
		);
		expect(repo.setGeneratedTitleIfBlank(process.id, "Later generated title")).toBeNull();
		expect(repo.getById(process.id)?.title).toBe("Generated title");
	});

	it("updates an process instance", () => {
		const repo = createProcessInstanceRepo(db);
		const turnRecords = createProcessTurnRecordRepo(db);
		const process = repo.create({ processId: "jira_issue_process", lifecycleStatus: "discovered" });
		const serverTurn = turnRecords.create({
			id: "trn_current",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "server_automatic",
		});
		const updated = repo.update(process.id, {
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			currentExecution: { kind: "server_turn", id: serverTurn.id },
		});

		expect(updated?.selectedTurnId).toBe("generate_plan");
		expect(updated?.lifecycleStatus).toBe("active");
		expect(updated?.currentExecution).toEqual({ kind: "server_turn", id: "trn_current" });
	});

	it("sets closedAt once when a process becomes terminal", () => {
		const repo = createProcessInstanceRepo(db);
		const process = repo.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const terminal = repo.update(process.id, {
			selectedTurnId: null,
			lifecycleStatus: "completed",
		});
		const renamed = repo.update(process.id, { title: "Generated after completion" });

		expect(terminal?.closedAt).toEqual(expect.any(String));
		expect(renamed?.closedAt).toBe(terminal?.closedAt);
		expect(renamed?.updatedAt).not.toBeNull();
	});

	it("lists all processes ordered by updatedAt desc", () => {
		const repo = createProcessInstanceRepo(db);
		repo.create({ processId: "jira_issue_process", lifecycleStatus: "discovered" });
		repo.create({ processId: "mr_polish_process", lifecycleStatus: "active" });

		const all = repo.listAll();
		expect(all).toHaveLength(2);
	});

	it("deletes an process instance", () => {
		const repo = createProcessInstanceRepo(db);
		const process = repo.create({ processId: "jira_issue_process", lifecycleStatus: "discovered" });

		expect(repo.delete(process.id)).toBe(true);
		expect(repo.getById(process.id)).toBeNull();
		expect(repo.delete("nonexistent")).toBe(false);
	});

	it("cascades deletion to all instance-owned child records", () => {
		const processes = createProcessInstanceRepo(db);
		const projects = createProcessProjectRepo(db);
		const inputs = createProcessInputRepo(db);
		const events = createProcessEventRepo(db);
		const turnRecords = createProcessTurnRecordRepo(db);
		const leafOutcomeSnapshots = createProcessLeafOutcomeSnapshotRepo(db);
		const turnAnnotations = createProcessTurnAnnotationRepo(db);
		const titleJobs = createProcessTitleJobRepo(db);
		const leases = createWorkerLeaseRepo(db);
		const externalWrites = createExternalWriteLogRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		projects.create({
			instanceId: process.id,
			key: "service-a",
			repoLocator: "git@gitlab.example.com:team/service-a.git",
			baseBranch: "main",
		});
		const input = inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Please continue",
		});
		events.create({
			instanceId: process.id,
			eventType: "lifecycle_changed",
		});
		leafOutcomeSnapshots.create({
			instanceId: process.id,
			leafEntryId: "assistant-plan",
			turnRecordId: "trn_cascade_1",
			rendererId: "test:plan.leaf_outcome",
			props: { title: "Plan" },
			fallbackMarkdown: "## Plan",
			status: "ready",
			anchoredAt: new Date().toISOString(),
		});
		turnRecords.create({
			id: "trn_cascade_1",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "server_automatic",
			status: "succeeded",
			pathType: "primary",
			endedAt: new Date().toISOString(),
		});
		turnAnnotations.create({
			id: "tan_cascade_1",
			instanceId: process.id,
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_cascade_1",
			references: [{ kind: "turn_record", turnRecordId: "trn_cascade_1", role: "subject" }],
			payload: { turnId: "generate_plan" },
		});
		leases.create({ instanceId: process.id, workerId: "wrk_cascade", state: "busy" });
		titleJobs.enqueueProcessJob({
			processInstanceId: process.id,
			processDefinitionId: process.processId,
			modelProfileId: "claude_fast",
			prompt: "Prompt",
			maxAttempts: 6,
			nextRunAt: new Date().toISOString(),
		});
		externalWrites.record({
			instanceId: process.id,
			writeType: "jira.remote_link.agent_detail",
			dedupKey: `dedup:${process.id}`,
		});

		expect(processes.delete(process.id)).toBe(true);
		expect(processes.getById(process.id)).toBeNull();
		expect(projects.listByInstance(process.id)).toHaveLength(0);
		expect(inputs.listByInstance(process.id)).toHaveLength(0);
		expect(inputs.delete(input.id)).toBe(false);
		expect(events.listByInstance(process.id)).toHaveLength(0);
		expect(leafOutcomeSnapshots.listByInstance(process.id)).toHaveLength(0);
		expect(turnRecords.listByInstance(process.id)).toHaveLength(0);
		expect(turnAnnotations.listByInstance(process.id)).toHaveLength(0);
		expect(titleJobs.listAll().filter((job) => job.processInstanceId === process.id)).toHaveLength(
			0,
		);
		expect(leases.getByInstance(process.id)).toBeNull();
		expect(externalWrites.listByInstance(process.id)).toHaveLength(0);
	});
});

describe("ProcessProjectRepo", () => {
	it("creates and lists projects for an process", () => {
		const processes = createProcessInstanceRepo(db);
		const projects = createProcessProjectRepo(db);

		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});
		const proj = projects.create({
			instanceId: process.id,
			key: "service-a",
			repoLocator: "git@gitlab.example.com:team/service-a.git",
			baseBranch: "main",
		});

		expect(proj.id).toMatch(/^prj_/);
		expect(proj.key).toBe("service-a");

		const list = projects.listByInstance(process.id);
		expect(list).toHaveLength(1);
		expect(projects.getById(proj.id)?.key).toBe("service-a");
	});

	it("finds project by process and key", () => {
		const processes = createProcessInstanceRepo(db);
		const projects = createProcessProjectRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});

		projects.create({
			instanceId: process.id,
			key: "service-a",
			repoLocator: "git@gitlab.example.com:team/service-a.git",
			baseBranch: "main",
		});

		const found = projects.getByInstanceAndKey(process.id, "service-a");
		expect(found).not.toBeNull();
		expect(found?.key).toBe("service-a");

		expect(projects.getByInstanceAndKey(process.id, "service-b")).toBeNull();
	});

	it("updates MR info on a project", () => {
		const processes = createProcessInstanceRepo(db);
		const projects = createProcessProjectRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});
		const proj = projects.create({
			instanceId: process.id,
			key: "service-a",
			repoLocator: "git@gitlab.example.com:team/service-a.git",
			baseBranch: "main",
		});

		const updated = projects.update(proj.id, {
			externalId: "77",
			externalUrl: "https://gitlab.example.com/team/service-a/-/merge_requests/77",
			pipelineStatus: "running",
		});

		expect(updated?.externalId).toBe("77");
		expect(updated?.pipelineStatus).toBe("running");
	});
});

describe("ProcessInputRepo", () => {
	it("creates inputs in sequence order", () => {
		const processes = createProcessInstanceRepo(db);
		const inputs = createProcessInputRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "First input",
		});
		inputs.create({
			instanceId: process.id,
			sequence: 2,
			source: "external_comment",
			kind: "instruction",
			bodyMarkdown: "Second input",
		});

		const all = inputs.listByInstance(process.id);
		expect(all).toHaveLength(2);
		expect(all[0].sequence).toBe(1);
		expect(all[1].sequence).toBe(2);
	});

	it("lists unconsumed inputs", () => {
		const processes = createProcessInstanceRepo(db);
		const inputs = createProcessInputRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		const inp1 = inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "First",
		});
		inputs.create({
			instanceId: process.id,
			sequence: 2,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Second",
		});

		inputs.markConsumed(inp1.id);

		const unconsumed = inputs.listUnconsumed(process.id);
		expect(unconsumed).toHaveLength(1);
		expect(unconsumed[0].sequence).toBe(2);
	});

	it("tracks max sequence", () => {
		const processes = createProcessInstanceRepo(db);
		const inputs = createProcessInputRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		expect(inputs.getMaxSequence(process.id)).toBe(0);

		inputs.create({
			instanceId: process.id,
			sequence: 5,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Input",
		});

		expect(inputs.getMaxSequence(process.id)).toBe(5);
	});
});

describe("ProcessEventRepo", () => {
	it("creates and lists events", () => {
		const processes = createProcessInstanceRepo(db);
		const events = createProcessEventRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});

		events.create({
			instanceId: process.id,
			eventType: "lifecycle_changed",
			data: { from: "discovered", to: "active" },
		});

		const list = events.listByInstance(process.id);
		expect(list).toHaveLength(1);
		expect(list[0].eventType).toBe("lifecycle_changed");
		expect(list[0].data).toEqual({ from: "discovered", to: "active" });
	});

	it("lists events by exact event types", () => {
		const processes = createProcessInstanceRepo(db);
		const events = createProcessEventRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		events.create({ instanceId: process.id, eventType: "pi.stream.delta" });
		events.create({ instanceId: process.id, eventType: "pi.retry.start" });
		events.create({ instanceId: process.id, eventType: "pi.compaction.end" });

		const listedEventTypes = events
			.listByInstanceEventTypes(process.id, ["pi.retry.start", "pi.compaction.end"], 10)
			.map((event) => event.eventType);
		expect(listedEventTypes).toHaveLength(2);
		expect(listedEventTypes).toEqual(
			expect.arrayContaining(["pi.compaction.end", "pi.retry.start"]),
		);
	});

	it("lists all matching event types by durable turn-record correlation", () => {
		const processes = createProcessInstanceRepo(db);
		const events = createProcessEventRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		events.create({
			instanceId: process.id,
			eventType: "pi.retry.start",
			data: { turnRecordId: "trn_target" },
		});
		for (let index = 0; index < 1_001; index += 1) {
			events.create({
				instanceId: process.id,
				eventType: "pi.error",
				data: { turnRecordId: `trn_other_${index}` },
			});
		}
		events.create({
			instanceId: process.id,
			eventType: "worker.trace",
			data: { turnRecordId: "trn_target" },
		});

		expect(
			events
				.listByInstanceTurnRecordEventTypes(process.id, "trn_target", [
					"pi.retry.start",
					"pi.error",
				])
				.map((event) => event.eventType),
		).toEqual(["pi.retry.start"]);
	});

	it("lists events since a timestamp with optional event-type prefix filtering", () => {
		const processes = createProcessInstanceRepo(db);
		const events = createProcessEventRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		events.create({
			instanceId: process.id,
			eventType: "process.event",
			data: { createdAt: "a" },
		});
		events.create({
			instanceId: process.id,
			eventType: "pi.stream.delta",
			data: { text: "hello" },
		});
		events.create({
			instanceId: process.id,
			eventType: "pi.tool.call",
			data: { name: "run_tests" },
		});

		const all = events.listByInstance(process.id, 10).slice().reverse();
		const sinceSecondEvent = all[1]?.createdAt;
		if (!sinceSecondEvent) {
			throw new Error("expected created second event timestamp");
		}

		const piEvents = events.listByInstanceSince(process.id, sinceSecondEvent, {
			limit: 10,
			eventTypePrefix: "pi.",
		});
		expect(piEvents.map((event) => event.eventType)).toEqual(["pi.tool.call", "pi.stream.delta"]);
		expect(
			events
				.listByInstanceSinceEventTypes(process.id, sinceSecondEvent, ["pi.tool.call"], 10)
				.map((event) => event.eventType),
		).toEqual(["pi.tool.call"]);
	});
});

describe("ProcessLeafOutcomeSnapshotRepo", () => {
	it("creates, lists, and looks up snapshots by instance and leaf entry", () => {
		const processes = createProcessInstanceRepo(db);
		const snapshots = createProcessLeafOutcomeSnapshotRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		const first = snapshots.create({
			instanceId: process.id,
			leafEntryId: "assistant-plan-1",
			turnRecordId: "trn_plan_1",
			rendererId: "test:plan.leaf_outcome",
			schemaVersion: 1,
			props: { title: "Plan v1" },
			fallbackMarkdown: "## Plan v1",
			status: "ready",
			anchoredAt: "2026-04-18T10:00:00.000Z",
		});
		snapshots.create({
			instanceId: process.id,
			leafEntryId: "assistant-plan-2",
			turnRecordId: "trn_plan_2",
			rendererId: "test:plan.leaf_outcome",
			fallbackMarkdown: "## Plan v2",
			status: "capture_error",
			warningCode: "capture_failed",
			warningMessage: "boom",
			anchoredAt: "2026-04-18T10:05:00.000Z",
		});

		expect(snapshots.listByInstance(process.id)).toEqual([
			expect.objectContaining({ leafEntryId: "assistant-plan-1", props: { title: "Plan v1" } }),
			expect.objectContaining({ leafEntryId: "assistant-plan-2", status: "capture_error" }),
		]);
		expect(snapshots.getByInstanceAndLeafEntryId(process.id, "assistant-plan-1")?.id).toBe(
			first.id,
		);
		expect(snapshots.getByInstanceAndLeafEntryId(process.id, "missing")).toBeNull();
	});
});

describe("ProcessTurnRecordRepo", () => {
	it("creates, updates, and lists turn records for a process", () => {
		const processes = createProcessInstanceRepo(db);
		const turnRecords = createProcessTurnRecordRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		const run = turnRecords.create({
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "server_automatic",
			forkPiEntryId: "pi_node_before_plan",
		});

		expect(run.id).toMatch(/^trn_/);
		expect(run.status).toBe("running");
		expect(run.pathType).toBe("primary");

		const updated = turnRecords.update(run.id, {
			status: "failed",
			errorSummary: "plan generation failed",
			turnResultMarkdown: "## Plan result",
			endedAt: new Date().toISOString(),
		});

		expect(updated?.status).toBe("failed");
		expect(updated?.errorSummary).toBe("plan generation failed");
		expect(updated?.turnResultMarkdown).toBe("## Plan result");

		const primarySucceeded = turnRecords.create({
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "server_automatic",
			status: "succeeded",
			pathType: "primary",
			resultPiEntryId: "pi_turn_1",
			endedAt: new Date().toISOString(),
		});
		turnRecords.create({
			instanceId: process.id,
			turnId: "run_llm_review",
			turnType: "server_automatic",
			status: "succeeded",
			pathType: "root_branch",
			resultPiEntryId: "pi_review_1",
			endedAt: new Date().toISOString(),
		});

		const all = turnRecords.listByInstance(process.id);
		expect(all).toHaveLength(3);
		expect(
			turnRecords.listByInstance(process.id).find((record) => record.status === "failed")?.id,
		).toBe(run.id);
		expect(turnRecords.getLatestSucceededPrimaryByInstance(process.id)?.id).toBe(
			primarySucceeded.id,
		);
	});
});

describe("ProcessTurnAnnotationRepo", () => {
	it("creates, updates, and deletes turn annotations for a process", () => {
		const processes = createProcessInstanceRepo(db);
		const turnAnnotations = createProcessTurnAnnotationRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		const annotation = turnAnnotations.create({
			instanceId: process.id,
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_plan_1",
			references: [
				{ kind: "turn_record", turnRecordId: "trn_plan_1", role: "subject" },
				{ kind: "entry", entryId: "ent_plan_1", role: "subject" },
			],
			payload: { turnId: "generate_plan", outcome: "plan_saved" },
		});

		expect(annotation.id).toMatch(/^tan_/);
		expect(turnAnnotations.findByKey(process.id, "turn_milestone:trn_plan_1")?.id).toBe(
			annotation.id,
		);

		const updated = turnAnnotations.update(annotation.id, {
			references: [
				{ kind: "turn_record", turnRecordId: "trn_plan_1", role: "subject" },
				{ kind: "entry", entryId: "ent_plan_1", role: "subject" },
				{ kind: "semantic_entry_ref", ref: "plan", role: "related" },
			],
			payload: { turnId: "generate_plan", outcome: "plan_saved", summary: "Initial plan" },
		});

		expect(updated?.references).toEqual([
			{ kind: "turn_record", turnRecordId: "trn_plan_1", role: "subject" },
			{ kind: "entry", entryId: "ent_plan_1", role: "subject" },
			{ kind: "semantic_entry_ref", ref: "plan", role: "related" },
		]);
		expect(updated?.payload).toMatchObject({ summary: "Initial plan" });

		expect(turnAnnotations.delete(annotation.id)).toBe(true);
		expect(turnAnnotations.getById(annotation.id)).toBeNull();
	});
});

describe("FutureExecutionRepo", () => {
	it("updates stored launch payloads only when the payload is unchanged", () => {
		const repo = createFutureExecutionRepo(db);
		const originalPayloadJson = JSON.stringify({ launchPlan: { processInput: { title: null } } });
		const execution = repo.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "local_repo_change_process",
			payloadJson: originalPayloadJson,
			nextRunAt: new Date().toISOString(),
		});

		expect(
			repo.updatePayloadJsonIfUnchanged(
				execution.id,
				originalPayloadJson,
				JSON.stringify({ launchPlan: { processInput: { title: "Generated title" } } }),
			)?.payloadJson,
		).toContain("Generated title");
		expect(
			repo.updatePayloadJsonIfUnchanged(
				execution.id,
				originalPayloadJson,
				JSON.stringify({ launchPlan: { processInput: { title: "Later title" } } }),
			),
		).toBeNull();
	});
});

describe("ProcessTitleJobRepo", () => {
	it("supersedes older active jobs for the same process target", () => {
		const processes = createProcessInstanceRepo(db);
		const repo = createProcessTitleJobRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});

		const first = repo.enqueueProcessJob({
			processInstanceId: process.id,
			processDefinitionId: process.processId,
			modelProfileId: "claude_fast",
			prompt: "Prompt one",
			maxAttempts: 6,
			nextRunAt: new Date().toISOString(),
		});
		expect(repo.markRunning(first.id)?.status).toBe("running");

		const second = repo.enqueueProcessJob({
			processInstanceId: process.id,
			processDefinitionId: process.processId,
			modelProfileId: "claude_fast",
			prompt: "Prompt two",
			maxAttempts: 6,
			nextRunAt: new Date().toISOString(),
		});

		expect(repo.getById(first.id)?.status).toBe("superseded");
		expect(repo.getById(second.id)?.status).toBe("pending");
	});

	it("claims due jobs, tracks attempts, and reschedules retries", () => {
		const processes = createProcessInstanceRepo(db);
		const repo = createProcessTitleJobRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "discovered",
		});
		const job = repo.enqueueProcessJob({
			processInstanceId: process.id,
			processDefinitionId: process.processId,
			modelProfileId: "claude_fast",
			prompt: "Prompt",
			maxAttempts: 6,
			nextRunAt: "2026-01-01T00:00:00.000Z",
		});

		expect(repo.listDuePending("2025-12-31T23:59:59.000Z", 10)).toEqual([]);
		expect(repo.listDuePending("2026-01-01T00:00:00.000Z", 10).map((entry) => entry.id)).toEqual([
			job.id,
		]);
		expect(repo.markRunning(job.id)?.attemptCount).toBe(1);
		expect(repo.reschedule(job.id, "2026-01-01T00:00:05.000Z", "provider timeout")?.status).toBe(
			"pending",
		);
		expect(repo.getById(job.id)?.lastError).toBe("provider timeout");
	});
});

describe("WorkerLeaseRepo", () => {
	it("creates and retrieves active lease for process", () => {
		const processes = createProcessInstanceRepo(db);
		const leases = createWorkerLeaseRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		const lease = leases.create({
			instanceId: process.id,
			workerId: "wrk_test1",
			state: "spawning",
		});

		expect(lease.id).toMatch(/^wls_/);
		expect(lease.state).toBe("spawning");

		const active = leases.getByInstance(process.id);
		expect(active).not.toBeNull();
		expect(active?.workerId).toBe("wrk_test1");
	});

	it("updates heartbeat", () => {
		const processes = createProcessInstanceRepo(db);
		const leases = createWorkerLeaseRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		leases.create({ instanceId: process.id, workerId: "wrk_test1", state: "busy" });
		expect(leases.updateHeartbeat("wrk_test1")).toBe(true);

		const updated = leases.listActive().find((lease) => lease.workerId === "wrk_test1");
		expect(updated?.lastHeartbeatAt).not.toBeNull();
	});

	it("lists active (non-exited) leases", () => {
		const processes = createProcessInstanceRepo(db);
		const leases = createWorkerLeaseRepo(db);

		const agent1 = processes.create({ processId: "jira_issue_process", lifecycleStatus: "active" });
		const agent2 = processes.create({ processId: "jira_issue_process", lifecycleStatus: "active" });

		const l1 = leases.create({ instanceId: agent1.id, workerId: "wrk_a", state: "busy" });
		leases.create({ instanceId: agent2.id, workerId: "wrk_b", state: "busy" });

		leases.update(l1.id, { state: "exited", exitedAt: new Date().toISOString() });

		const active = leases.listActive();
		expect(active).toHaveLength(1);
		expect(active[0].workerId).toBe("wrk_b");
	});
});

describe("ExternalWriteLogRepo", () => {
	it("records and deduplicates writes", () => {
		const processes = createProcessInstanceRepo(db);
		const ewl = createExternalWriteLogRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		const entry = ewl.record({
			instanceId: process.id,
			writeType: "jira.remote_link.agent_detail",
			dedupKey: "CLD-123:jira.remote_link.agent_detail:http://localhost/processes/agt_1",
		});

		expect(entry.id).toMatch(/^ewl_/);
		expect(ewl.hasDedupKey(entry.dedupKey)).toBe(true);
		expect(ewl.hasDedupKey("nonexistent")).toBe(false);
	});

	it("rejects duplicate dedup keys", () => {
		const processes = createProcessInstanceRepo(db);
		const ewl = createExternalWriteLogRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			lifecycleStatus: "active",
		});

		ewl.record({
			instanceId: process.id,
			writeType: "jira.remote_link.agent_detail",
			dedupKey: "dup",
		});

		expect(() => {
			ewl.record({
				instanceId: process.id,
				writeType: "jira.remote_link.agent_detail",
				dedupKey: "dup",
			});
		}).toThrow();
	});
});
