import { describe, expect, it } from "vitest";
import { normalizeTurnPreparationData, recordTurnPreparation } from "./turn-preparation.js";

describe("LLM turn preparation checkpoints", () => {
	it("accepts bounded JSON data and rejects unsupported values", () => {
		expect(normalizeTurnPreparationData({ snapshot: { path: "/tmp/snapshot" } })).toEqual({
			ok: true,
			data: { snapshot: { path: "/tmp/snapshot" } },
		});
		expect(normalizeTurnPreparationData(undefined)).toEqual({ ok: false });
		expect(normalizeTurnPreparationData({ value: BigInt(1) })).toEqual({ ok: false });
	});

	it("persists one checkpoint for the current running LLM turn", () => {
		const events: Array<{ eventType: string; data: Record<string, unknown> }> = [];
		const process = { id: "agt_1", selectedTurnId: "analyze" };
		const running = {
			id: "trn_1",
			instanceId: "agt_1",
			turnId: "analyze",
			turnType: "llm",
			status: "running",
		};
		const deps = {
			processes: { getById: () => process },
			turnRecords: { getById: (id: string) => (id === running.id ? running : null) },
			events: {
				create: (event: (typeof events)[number]) => events.push(event),
				listByInstanceTurnRecordEventTypes: () => events,
			},
		} as never;

		expect(
			recordTurnPreparation(deps, {
				instanceId: "agt_1",
				turnRecordId: "trn_1",
				data: { snapshotDir: "/tmp/snapshot" },
			}),
		).toBe(true);
		expect(events).toEqual([
			{
				instanceId: "agt_1",
				eventType: "turn.prepared",
				data: { turnRecordId: "trn_1", data: { snapshotDir: "/tmp/snapshot" } },
			},
		]);
		expect(
			recordTurnPreparation(deps, {
				instanceId: "agt_1",
				turnRecordId: "trn_1",
				data: { snapshotDir: "/tmp/other" },
			}),
		).toBe(false);
	});
});
