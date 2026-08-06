import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, type LeitwerkDb } from "./db/database.js";
import { createProcessInputRepo, createProcessInstanceRepo } from "./db/repositories.js";
import {
	buildInputQueuedFrames,
	persistQueuedProcessInputs,
	validateQueuedProcessInput,
} from "./process-input-dispatch.js";

let db: LeitwerkDb;

beforeEach(() => {
	db = createInMemoryDatabase();
});

describe("persistQueuedProcessInputs", () => {
	it("returns empty when there is nothing to persist", () => {
		const inputs = createProcessInputRepo(db);
		const created = persistQueuedProcessInputs(inputs, "agt_missing", []);

		expect(created).toEqual([]);
		expect(buildInputQueuedFrames("agt_missing", created)).toEqual([]);
	});

	it("creates queued inputs in sequence order and builds post-commit frames", () => {
		const processes = createProcessInstanceRepo(db);
		const inputs = createProcessInputRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		inputs.create({
			instanceId: process.id,
			sequence: 2,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Existing input",
		});

		const created = persistQueuedProcessInputs(inputs, process.id, [
			{
				source: "app_steer",
				kind: "instruction",
				bodyMarkdown: "First queued input",
			},
			{
				source: "external_comment",
				kind: "instruction",
				bodyMarkdown: "Second queued input",
			},
		]);

		expect(created).toHaveLength(2);
		expect(created.map((input) => input.sequence)).toEqual([3, 4]);
		expect(inputs.listByInstance(process.id).map((input) => input.sequence)).toEqual([2, 3, 4]);
		const frames = buildInputQueuedFrames(process.id, created);
		expect(frames).toHaveLength(2);
		expect(frames.map((frame) => frame.type)).toEqual([
			"process.input.queued",
			"process.input.queued",
		]);
		expect(frames[0]?.payload).toMatchObject({
			instanceId: process.id,
			input: { id: created[0]?.id, sequence: 3, bodyMarkdown: "First queued input" },
		});
		expect(frames[1]?.payload).toMatchObject({
			instanceId: process.id,
			input: { id: created[1]?.id, sequence: 4, bodyMarkdown: "Second queued input" },
		});
	});

	it("persists queued semantic input targets alongside the durable input", () => {
		const processes = createProcessInstanceRepo(db);
		const inputs = createProcessInputRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "review_turn",
			lifecycleStatus: "active",
		});
		const [created] = persistQueuedProcessInputs(inputs, process.id, [
			{
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "review" },
				bodyMarkdown: "Tighten the review findings.",
			},
		]);

		expect(created).toMatchObject({
			target: { semanticRef: "review" },
			bodyMarkdown: "Tighten the review findings.",
		});
		expect(inputs.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				id: created?.id,
				target: { semanticRef: "review" },
			}),
		]);
	});

	it("persists queued product input targets alongside the durable input", () => {
		const processes = createProcessInstanceRepo(db);
		const inputs = createProcessInputRepo(db);
		const process = processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "simplification_decision",
			lifecycleStatus: "active",
		});
		const [created] = persistQueuedProcessInputs(inputs, process.id, [
			{
				source: "action_prompt",
				kind: "instruction",
				target: { productName: "simplification-plan" },
				bodyMarkdown: "Apply the simplification plan.",
			},
		]);

		expect(created).toMatchObject({
			target: { productName: "simplification-plan" },
			bodyMarkdown: "Apply the simplification plan.",
		});
		expect(inputs.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				id: created?.id,
				target: { productName: "simplification-plan" },
			}),
		]);
	});
});

describe("validateQueuedProcessInput", () => {
	it("rejects targeted inputs whose kind is not instruction", () => {
		expect(
			validateQueuedProcessInput({
				source: "action_prompt",
				kind: "system_event",
				target: { semanticRef: "review" },
				bodyMarkdown: "invalid",
			}),
		).toContain("requires kind 'instruction'");
	});

	it("accepts product-targeted inputs", () => {
		expect(
			validateQueuedProcessInput({
				source: "action_prompt",
				kind: "instruction",
				target: { productName: "simplification-plan" },
				bodyMarkdown: "Apply the simplification plan.",
			}),
		).toBeNull();
	});

	it("rejects targets that set both semantic ref and product name", () => {
		expect(
			validateQueuedProcessInput({
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "review", productName: "simplification-plan" } as never,
				bodyMarkdown: "Apply the simplification plan.",
			}),
		).toContain("only one of semantic ref or product name");
	});

	it("rejects blank targeted inputs", () => {
		expect(
			validateQueuedProcessInput({
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "review" },
				bodyMarkdown: "   ",
			}),
		).toContain("requires a non-empty bodyMarkdown");
	});
});
