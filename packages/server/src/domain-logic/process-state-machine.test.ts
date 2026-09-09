import { describe, expect, it } from "vitest";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../test-helpers/process-fixtures.js";
import { canAbort, tryTransition } from "./process-state-machine.js";

const registry = createDefaultTestProcessGraphRegistry();

describe("process-state-machine", () => {
	it("selects the only entry turn for a discovered process", () => {
		const result = tryTransition(
			registry,
			"ticket_issue_process",
			null,
			"start",
			undefined,
			"discovered",
		);
		expect(result).toMatchObject({
			ok: true,
			fromTurnId: null,
			toTurnId: "generate_plan",
			trigger: "start",
		});
	});

	it("defaults to the primary entry and accepts an explicit alternate entry", () => {
		const process = createFixtureProcess({
			id: "multi_entry_process",
			entry: "generate_plan",
			alternateEntries: ["import_plan"],
		});
		const multiEntryRegistry = createProcessGraphRegistry([process]);

		expect(
			tryTransition(multiEntryRegistry, process.id, null, undefined, undefined, "discovered"),
		).toMatchObject({ ok: true, toTurnId: "generate_plan", trigger: "start" });
		expect(
			tryTransition(multiEntryRegistry, process.id, null, "start", "import_plan", "discovered"),
		).toMatchObject({ ok: true, toTurnId: "import_plan" });
		expect(
			tryTransition(multiEntryRegistry, process.id, null, "start", "missing", "discovered"),
		).toMatchObject({ ok: false, code: "invalid_transition" });
		expect(
			tryTransition(multiEntryRegistry, process.id, null, undefined, null, "discovered"),
		).toEqual({
			ok: false,
			code: "invalid_transition",
			message: "Turn 'null' is not a declared entry turn for process 'multi_entry_process'",
			fromTurnId: null,
			toTurnId: null,
		});
	});

	it("validates direct turn-to-turn transitions on the graph", () => {
		const result = tryTransition(
			registry,
			"ticket_issue_process",
			"implement",
			undefined,
			"handoff_review",
		);
		expect(result).toMatchObject({
			ok: true,
			fromTurnId: "implement",
			toTurnId: "handoff_review",
		});
	});

	it("requires an explicit target when multiple next turns exist", () => {
		const result = tryTransition(registry, "ticket_issue_process", "plan_review");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_transition");
		expect(result.message).toContain("Ambiguous turn transition");
	});

	it.each([null, "run_llm_review"])("rejects non-graph target %s", (target) => {
		const result = tryTransition(
			registry,
			"ticket_issue_process",
			"generate_plan",
			undefined,
			target,
		);
		expect(result).toMatchObject({
			ok: false,
			code: "invalid_transition",
			fromTurnId: "generate_plan",
			toTurnId: target ?? "generate_plan",
		});
	});

	describe("canAbort", () => {
		it("returns false only for terminal lifecycle statuses", () => {
			expect(canAbort("completed")).toBe(false);
			expect(canAbort("aborted")).toBe(false);
			expect(canAbort("discovered")).toBe(true);
			expect(canAbort("active")).toBe(true);
			expect(canAbort("waiting")).toBe(true);
			expect(canAbort("error")).toBe(true);
		});
	});
});
