import { describe, expect, it } from "vitest";
import type { ProcessInstance, ProcessProject } from "./domain-model.js";
import { buildProcessRowSlot, sortProcessRows } from "./process-row-slots.js";

function process(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	const processId = overrides.processId ?? "ticket_issue_process";
	return {
		id: "agent-uuid",
		processId,
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		currentExecution: null,
		planRevision: 1,
		title: null,
		externalId: "PROJ-100",
		externalUrl: null,
		metadata: null,
		defaultModelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function proj(overrides: Partial<ProcessProject> = {}): ProcessProject {
	return {
		id: "p1",
		instanceId: "agent-uuid",
		key: "my-service",
		repoLocator: "https://codehost.example/group/my-service.git",
		repoLocatorKind: "remote_url",
		baseBranch: "main",
		workBranch: "feat-1",
		externalId: "55",
		externalUrl: "https://codehost.example/group/my-service/-/merge_requests/55",
		metadata: null,
		pipelineStatus: "success",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("process-row-slots", () => {
	describe("buildProcessRowSlot", () => {
		it("prefers the explicit process title when present", () => {
			const row = buildProcessRowSlot(
				process({ title: "Implement caching", externalId: "ABC-42" }),
				[proj(), proj({ id: "p2", key: "other" })],
			);
			expect(row.title).toBe("Implement caching");
			expect(row.externalId).toBe("ABC-42");
			expect(row.projectCount).toBe(2);
			expect(row.externalLinkCount).toBe(2);
		});

		it("falls back to externalId when no explicit process title is present", () => {
			const row = buildProcessRowSlot(process({ externalId: "ABC-42" }), [
				proj(),
				proj({ id: "p2", key: "other" }),
			]);
			expect(row.title).toBe("ABC-42");
			expect(row.externalId).toBe("ABC-42");
			expect(row.projectCount).toBe(2);
			expect(row.externalLinkCount).toBe(2);
		});

		it("falls back to process id when externalId is null", () => {
			const row = buildProcessRowSlot(process({ externalId: null }), [proj({ externalId: null })]);
			expect(row.title).toBe("agent-uuid");
			expect(row.externalLinkCount).toBe(0);
		});

		it("categorizes rows from lifecycle status", () => {
			expect(buildProcessRowSlot(process({ lifecycleStatus: "active" }), []).statusCategory).toBe(
				"active",
			);
			expect(buildProcessRowSlot(process({ lifecycleStatus: "error" }), []).statusCategory).toBe(
				"error",
			);
			expect(buildProcessRowSlot(process({ lifecycleStatus: "waiting" }), []).statusCategory).toBe(
				"waiting",
			);
			expect(
				buildProcessRowSlot(process({ lifecycleStatus: "discovered", selectedTurnId: null }), [])
					.statusCategory,
			).toBe("discovered");
			expect(
				buildProcessRowSlot(process({ lifecycleStatus: "completed", selectedTurnId: null }), [])
					.statusCategory,
			).toBe("terminal");
		});
	});

	describe("sortProcessRows", () => {
		it("orders error before active before waiting before discovered before terminal; alphabetical by title within category", () => {
			const terminal = buildProcessRowSlot(
				process({ id: "t", lifecycleStatus: "completed", selectedTurnId: null, externalId: "Z-T" }),
				[],
			);
			const waiting = buildProcessRowSlot(
				process({ id: "w", lifecycleStatus: "waiting", externalId: "W-1" }),
				[],
			);
			const activeZ = buildProcessRowSlot(
				process({ id: "z", lifecycleStatus: "active", externalId: "ZZZ-9" }),
				[],
			);
			const discovered = buildProcessRowSlot(
				process({
					id: "d",
					lifecycleStatus: "discovered",
					selectedTurnId: null,
					externalId: "D-1",
				}),
				[],
			);
			const activeA = buildProcessRowSlot(
				process({ id: "a", lifecycleStatus: "active", externalId: "AAA-1" }),
				[],
			);
			const errored = buildProcessRowSlot(
				process({ id: "e", lifecycleStatus: "error", externalId: "ERR-1" }),
				[],
			);

			const sorted = sortProcessRows([terminal, waiting, activeZ, discovered, activeA, errored]);

			expect(sorted.map((r) => r.statusCategory)).toEqual([
				"error",
				"active",
				"active",
				"waiting",
				"discovered",
				"terminal",
			]);
			expect(sorted[0].title).toBe("ERR-1");
			expect(sorted[1].title).toBe("AAA-1");
			expect(sorted[2].title).toBe("ZZZ-9");
		});
	});
});
