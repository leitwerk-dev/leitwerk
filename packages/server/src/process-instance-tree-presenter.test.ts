import type { InspectionContextObservation, ProcessTurnRecord } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { presentProcessInstanceTree } from "./process-instance-tree-presenter.js";
import {
	createTestProcessInstance,
	createTestTurnRecord,
} from "./test-helpers/process-model-fixtures.js";

const process = createTestProcessInstance({ id: "run", lifecycleStatus: "completed" });
const record = (id: string, overrides: Partial<ProcessTurnRecord> = {}) =>
	createTestTurnRecord({
		id,
		instanceId: process.id,
		turnId: id,
		resultPiEntryId: `${id}-result`,
		...overrides,
	});

describe("recorded context map", () => {
	it("includes all executions without treating chronology, retries or decisions as inheritance", () => {
		const records = [
			record("a"),
			record("b", { turnType: "human" }),
			record("c", { turnType: "automatic" }),
			record("d", { turnType: "external" }),
			record("retry", { attempt: 2 }),
		];
		const tree = presentProcessInstanceTree({ process, turnRecords: records });
		expect(tree.nodes).toHaveLength(5);
		expect(tree.edges).toEqual([]);
		expect(tree.nodes.find((node) => node.id === "retry")?.origin?.conversation.state).toBe(
			"not_recorded",
		);
		expect(tree.nodes.find((node) => node.id === "b")?.origin?.conversation.state).toBe(
			"not_applicable",
		);
	});
	it("uses a recorded intermediate entry and the supplied product version even after republication", () => {
		const records = [
			record("producer"),
			record("consumer", { forkPiEntryId: "middle" }),
			record("republish"),
		];
		const observations: InspectionContextObservation[] = [
			{
				id: "link",
				turnRecordId: "producer",
				fact: { kind: "entry_link", entryId: "middle", piTurnId: "pi", role: "assistant" },
			},
			{
				id: "supply",
				turnRecordId: "consumer",
				fact: {
					kind: "supplied_context",
					origin: null,
					products: [
						{ name: "plan", producerTurnRecordId: "producer", entryId: "producer-result" },
					],
				},
			},
		];
		const tree = presentProcessInstanceTree({ process, turnRecords: records, observations });
		expect(tree.nodes.find((node) => node.id === "consumer")?.parentId).toBe("producer");
		expect(tree.edges).toEqual([
			expect.objectContaining({
				sourceNodeId: "producer",
				targetNodeId: "consumer",
				hasContext: true,
				productLabels: [],
			}),
			expect.objectContaining({
				sourceNodeId: "producer",
				targetNodeId: "consumer",
				hasContext: false,
				productLabels: ["plan"],
			}),
		]);
	});
	it("never invents supply from the current workflow contract", () => {
		const tree = presentProcessInstanceTree({
			process,
			turnRecords: [record("a"), record("b")],
			turnDetails: [
				{
					turnId: "a",
					description: "A",
					pathType: "primary",
					consumedProducts: [],
					publishedProducts: ["plan"],
					activePiToolNames: [],
					outcomeActions: [],
				},
				{
					turnId: "b",
					description: "B",
					pathType: "primary",
					consumedProducts: ["plan"],
					publishedProducts: [],
					activePiToolNames: [],
					outcomeActions: [],
				},
			],
		});
		expect(tree.edges).toEqual([]);
	});
});
