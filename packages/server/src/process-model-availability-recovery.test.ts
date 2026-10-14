import { describe, expect, it, vi } from "vitest";
import { recoverModelAvailabilityFailures } from "./process-model-availability-recovery.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";
import {
	createModelAvailabilitySnapshot,
	createTestModelPolicy,
	createTestProcessInstance,
} from "./test-helpers/process-model-fixtures.js";

function process() {
	return createTestProcessInstance({
		id: "p1",
		lifecycleStatus: "error",
		currentExecution: { kind: "worker_start", id: "s1" },
		planRevision: 1,
		selectedTurnModelProfileId: "profile",
		selectedTurnModelKind: "inherited",
		selectedTurnModelSource: "catalog_default",
	});
}

function start(code: "model_unavailable" | "model_stale" | "provider_preflight_failed") {
	return {
		id: "s1",
		instanceId: "p1",
		turnId: "run",
		turnType: "llm" as const,
		proposedTurnRecordId: "t1",
		startKind: "selected_turn" as const,
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "preparation_failed" as const,
			requestedModelProfileId: "profile",
			providerOptions: {},
			code,
			safeSummary: "Unavailable",
			modelSelectionProvenance: { kind: "inherited" as const, source: "catalog_default" as const },
			availabilityRevision: 1,
		},
		createdAt: "",
		updatedAt: "",
	};
}

const availability = createModelAvailabilitySnapshot([], 2);

function policy(): ServerProcessModelPolicy {
	const base = createTestModelPolicy().policy;
	return {
		...base,
		evaluate: (request) =>
			request.kind === "preparation_recovery"
				? {
						ok: true,
						selection: {
							modelProfileId: "profile",
							provenance: { kind: "inherited", source: "catalog_default" },
						},
						availabilityRevision: 2,
					}
				: base.evaluate(request),
	};
}

describe("model availability recovery", () => {
	it("retries a current pre-acceptance availability failure", async () => {
		const retryStartupAutomatically = vi.fn(async () => ({
			ok: true as const,
			process: process(),
			data: {
				status: "retried" as const,
				reason: "Restored",
				starts: 2,
				maxStarts: 3,
				nextRetryAt: null,
			},
		}));
		const recovered = await recoverModelAvailabilityFailures({
			processes: { listAll: () => [process()] },
			turnStarts: { getById: (id) => (id === "s1" ? start("model_unavailable") : null) },
			commands: { retryStartupAutomatically },
			policy: policy(),
			availability,
			cause: "availability_transition",
		});
		expect(recovered).toBe(1);
		expect(retryStartupAutomatically).toHaveBeenCalledWith("p1", "s1", {
			availabilityCause: "availability_transition",
		});
	});

	it("does not filter inherited recovery by the previously requested profile", async () => {
		const retryStartupAutomatically = vi.fn(async () => ({
			ok: true as const,
			process: process(),
			data: {
				status: "retried" as const,
				reason: "Restored",
				starts: 2,
				maxStarts: 3,
				nextRetryAt: null,
			},
		}));
		await recoverModelAvailabilityFailures({
			processes: { listAll: () => [process()] },
			turnStarts: { getById: (id) => (id === "s1" ? start("model_unavailable") : null) },
			commands: { retryStartupAutomatically },
			policy: policy(),
			availability,
			cause: "availability_transition",
			profileIds: new Set(["replacement"]),
		});

		expect(retryStartupAutomatically).toHaveBeenCalledWith("p1", "s1", {
			availabilityCause: "availability_transition",
		});
	});

	it("suppresses the benign stale turn-start race", async () => {
		const warn = vi.fn();
		const retryStartupAutomatically = vi.fn(async () => ({
			ok: false as const,
			code: "stale_turn_start" as const,
			error: "already replaced",
		}));
		const recovered = await recoverModelAvailabilityFailures({
			processes: { listAll: () => [process()] },
			turnStarts: { getById: (id) => (id === "s1" ? start("model_unavailable") : null) },
			commands: { retryStartupAutomatically },
			policy: policy(),
			availability,
			cause: "availability_transition",
			logger: { warn },
		});
		expect(retryStartupAutomatically).toHaveBeenCalledExactlyOnceWith("p1", "s1", {
			availabilityCause: "availability_transition",
		});
		expect(recovered).toBe(0);
		expect(warn).not.toHaveBeenCalled();
	});

	it("never retries provider preflight failures", async () => {
		const retryStartupAutomatically = vi.fn();
		await recoverModelAvailabilityFailures({
			processes: { listAll: () => [process()] },
			turnStarts: { getById: (id) => (id === "s1" ? start("provider_preflight_failed") : null) },
			commands: { retryStartupAutomatically },
			policy: policy(),
			availability,
			cause: "startup_reconciliation",
		});
		expect(retryStartupAutomatically).not.toHaveBeenCalled();
	});
});
