import { describe, expect, it } from "vitest";
import {
	createTestModelPolicy,
	createTestProcessInstance,
	createTestTurnStart,
} from "../test-helpers/process-model-fixtures.js";

describe("server process model policy fingerprint", () => {
	it("includes start identity and excludes only the prepared availability revision", () => {
		const { policy } = createTestModelPolicy({ profiles: [{ id: "first", model_id: "one" }] });
		const process = createTestProcessInstance({
			currentExecution: { kind: "worker_start", id: "s1" },
			planRevision: 1,
		});
		const start = createTestTurnStart();
		const original = policy.fingerprint({ process, currentStart: start });
		const revisionChanged = structuredClone(start);
		if (revisionChanged.state.kind === "starting" && revisionChanged.state.start.kind === "llm")
			revisionChanged.state.start.availabilityRevision = 99;
		expect(policy.fingerprint({ process, currentStart: revisionChanged })).toBe(original);
		expect(policy.fingerprint({ process, currentStart: { ...start, id: "s2" } })).not.toBe(
			original,
		);
	});

	it("remains sensitive to nested worker config named availabilityRevision", () => {
		const process = createTestProcessInstance({
			currentExecution: { kind: "worker_start", id: "s1" },
			planRevision: 1,
		});
		const start = createTestTurnStart();
		const fingerprint = (availabilityRevision: number) =>
			createTestModelPolicy({
				profiles: [
					{ id: "first", model_id: "one", provider_options: { nested: { availabilityRevision } } },
				],
			}).policy.fingerprint({ process, currentStart: start });
		expect(fingerprint(1)).not.toBe(fingerprint(2));
	});
});
