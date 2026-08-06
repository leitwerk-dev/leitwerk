import { describe, expect, it } from "vitest";
import { classifyWorkerDescriptor } from "./adoption-plan.js";

const descriptor = { instanceId: "proc-1", workerId: "wkr-1", unitId: "unit-1" };
const process = { id: "proc-1" };
const MODEL_POLICY_FINGERPRINT = "model-policy-v1";
const lease = {
	workerId: "wkr-1",
	state: "busy" as const,
	connectTokenHash: "hash",
	modelPolicyFingerprint: MODEL_POLICY_FINGERPRINT,
};

function classify(overrides: Partial<Parameters<typeof classifyWorkerDescriptor>[0]> = {}) {
	return classifyWorkerDescriptor({
		descriptor,
		process,
		lease,
		expectedModelPolicyFingerprint: MODEL_POLICY_FINGERPRINT,
		alreadyAttached: false,
		...overrides,
	});
}

describe("classifyWorkerDescriptor", () => {
	it("adopts descriptors that match an active tokenized lease and model policy", () => {
		expect(classify()).toBe("adopt");
	});

	it.each([
		["missing process", null, lease],
		["missing lease", process, null],
		["worker mismatch", process, { ...lease, workerId: "other" }],
		["terminal lease", process, { ...lease, state: "exited" as const }],
		["missing token", process, { ...lease, connectTokenHash: null }],
		["legacy missing model policy", process, { ...lease, modelPolicyFingerprint: null }],
		[
			"changed model policy",
			process,
			{ ...lease, modelPolicyFingerprint: "different-model-policy" },
		],
	])("stops stale descriptors for %s", (_name, processValue, leaseValue) => {
		expect(classify({ process: processValue, lease: leaseValue })).toBe("stop_stale");
	});

	it("stops stale descriptors for terminal observed runner state", () => {
		expect(classify({ descriptor: { ...descriptor, observedState: "terminal" } })).toBe(
			"stop_stale",
		);
	});

	it("ignores descriptors for processes that are already attached to the same unit", () => {
		expect(
			classify({
				alreadyAttached: true,
				attachedDescriptorKey: "/unit-1",
			}),
		).toBe("ignore_foreign");
	});

	it("stops duplicate descriptors for an already attached process", () => {
		expect(
			classify({
				descriptor: { ...descriptor, unitId: "unit-2" },
				alreadyAttached: true,
				attachedDescriptorKey: "/unit-1",
			}),
		).toBe("stop_stale");
	});
});
