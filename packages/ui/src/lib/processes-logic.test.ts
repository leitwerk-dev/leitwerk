import type { ProcessInput, ProcessInstance } from "@leitwerk-dev/domain";
import {
	createDurableWsFrame,
	createEphemeralWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { classifyWsEvent, createRequestGuard } from "./processes-logic.js";

function durableFrame(input: Parameters<typeof createDurableWsFrame>[0]) {
	return createDurableWsFrame({ ...input, sentAt: "2026-01-01T00:00:00Z" });
}

function ephemeralFrame(input: Parameters<typeof createEphemeralWsFrame>[0]) {
	return createEphemeralWsFrame({ ...input, sentAt: "2026-01-01T00:00:00Z" });
}

function makeProcess(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return {
		id: "agt_1",
		processId: "jira_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		planRevision: 0,
		title: null,
		externalId: "PROJ-1",
		externalUrl: null,
		metadata: null,
		modelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeInput(): ProcessInput {
	return {
		id: "inp_1",
		instanceId: "agt_1",
		sequence: 1,
		source: "app_steer",
		kind: "instruction",
		target: null,
		bodyMarkdown: "Please review",
		receivedAt: "2026-01-01T00:00:00Z",
		consumedAt: null,
	};
}

describe("createRequestGuard", () => {
	it("marks superseded and invalidated requests stale", () => {
		const guard = createRequestGuard();
		const first = guard.next();
		expect(guard.isStale(first)).toBe(false);
		const second = guard.next();
		expect(guard.isStale(first)).toBe(true);
		expect(guard.isStale(second)).toBe(false);
		guard.invalidate();
		expect(guard.isStale(second)).toBe(true);
	});
});

describe("classifyWsEvent", () => {
	it("refreshes server-owned list projections after process creation", () => {
		const process = makeProcess({ id: "agt_created" });
		expect(
			classifyWsEvent(
				durableFrame({
					type: "process.created",
					payload: { process, processId: process.processId },
				}),
				null,
			),
		).toEqual([{ kind: "reload_list" }, { kind: "refresh_active_browse" }]);
	});

	it("refreshes lists and removes the matching detail after deletion", () => {
		const frame = durableFrame({
			type: "process.deleted",
			instanceId: "agt_1",
			payload: { instanceId: "agt_1" },
		});
		expect(classifyWsEvent(frame, "agt_1")).toEqual([
			{ kind: "reload_list" },
			{ kind: "refresh_active_browse" },
			{ kind: "remove_deleted_detail", instanceId: "agt_1" },
		]);
		expect(classifyWsEvent(frame, "agt_2")).toEqual([
			{ kind: "reload_list" },
			{ kind: "refresh_active_browse" },
		]);
	});

	it("refreshes list and detail projections after process updates", () => {
		const frame = durableFrame({
			type: "process.updated",
			instanceId: "agt_1",
			payload: { process: { selectedTurnId: "implement" } },
		});
		expect(classifyWsEvent(frame, null)).toEqual([
			{ kind: "reload_list" },
			{ kind: "refresh_active_browse" },
		]);
		expect(classifyWsEvent(frame, "agt_1")).toEqual([
			{ kind: "reload_list" },
			{ kind: "refresh_active_browse" },
			{ kind: "reload_detail", instanceId: "agt_1" },
		]);
	});

	it("does not reload detail for a different process", () => {
		const actions = classifyWsEvent(
			durableFrame({
				type: "process.updated",
				instanceId: "agt_2",
				payload: { process: { lifecycleStatus: "completed", selectedTurnId: null } },
			}),
			"agt_1",
		);
		expect(actions.some((action) => action.kind === "reload_detail")).toBe(false);
	});

	it("ignores raw pi.* diagnostic frames", () => {
		expect(
			classifyWsEvent(
				ephemeralFrame({
					type: "pi.stream.delta",
					instanceId: "agt_1",
					payload: { text: "hello " },
				}),
				null,
			),
		).toEqual([{ kind: "ignored" }]);
	});

	it("reloads all detail-scoped durable events", () => {
		const frames = [
			durableFrame({
				type: "plan.updated",
				instanceId: "agt_1",
				payload: {
					planRevision: 1,
					reviewState: "awaiting_approval",
					approved: false,
					summary: "summary",
				},
			}),
			durableFrame({
				type: "review.updated",
				instanceId: "agt_1",
				payload: { hasIssues: false, issueCount: 0, nextTurnId: null },
			}),
			durableFrame({
				type: "process.input.queued",
				instanceId: "agt_1",
				payload: { instanceId: "agt_1", input: makeInput() },
			}),
		];
		for (const frame of frames) {
			expect(classifyWsEvent(frame, "agt_1")).toContainEqual({
				kind: "reload_detail",
				instanceId: "agt_1",
			});
		}
	});

	it("applies primary-path frames incrementally", () => {
		const actions = classifyWsEvent(
			ephemeralFrame({
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_1",
					piTurnId: "turn-1",
					text: "hello",
					streamType: "text",
					timestamp: "2026-01-01T00:00:00Z",
				},
			}),
			"agt_1",
		);
		expect(actions[0]).toMatchObject({ kind: "apply_primary_path_frame", instanceId: "agt_1" });
	});
});
