import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { createPiResourceBundleCache } from "./bundle-cache.js";
import { createPiResourceBundlePinReconciler } from "./bundle-pin-lifecycle.js";

function createStartingLlmProcess(digest: string, deps = createTestDeps()) {
	const process = deps.processes.create({
		processId: "p",
		selectedTurnId: "t",
		lifecycleStatus: "active",
	});
	const start = deps.turnStarts.create({
		instanceId: process.id,
		turnId: "t",
		turnType: "llm",
		proposedTurnRecordId: `${process.id}-turn`,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "starting",
			start: {
				kind: "llm",
				model: { profileId: "m", providerId: "p", modelId: "m", thinkingLevel: "off" },
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: digest,
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
		},
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	const activeProcess = deps.processes.getById(process.id);
	if (!activeProcess) throw new Error("Expected process");
	return { process: activeProcess, start, deps };
}

describe("Pi resource bundle pin lifecycle", () => {
	it("pins only a current starting or accepted running LLM start", () => {
		const deps = createTestDeps();
		const cache = createPiResourceBundleCache();
		const bundle = createCanonicalPiResourceBundle([
			{ path: "settings.json", content: Buffer.from("{}") },
		]);
		cache.put(bundle);
		const { process, start } = createStartingLlmProcess(bundle.digest, deps);
		const reconciler = createPiResourceBundlePinReconciler({ ...deps, bundleCache: cache });

		expect(reconciler.reconcile(process)).toEqual({
			missingDigest: null,
		});
		expect(cache.stats().pins).toBe(1);
		deps.turnStarts.compareAndSetState({
			id: start.id,
			expectedKind: "starting",
			state: {
				kind: "bootstrap_failed",
				start: start.state.start,
				failedWorkerLeaseId: null,
				code: "x",
				safeSummary: "x",
			},
		});
		const failedProcess = deps.processes.getById(process.id);
		if (!failedProcess) throw new Error("Expected process");
		reconciler.reconcile(failedProcess);
		expect(cache.stats().pins).toBe(0);
	});

	it("reports an absent current bundle without pinning it", () => {
		const { process, deps } = createStartingLlmProcess("missing");
		const reconciler = createPiResourceBundlePinReconciler({
			...deps,
			bundleCache: createPiResourceBundleCache(),
		});
		expect(reconciler.reconcile(process)).toEqual({
			missingDigest: "missing",
		});
	});

	it("retries a missing replacement without releasing another process's shared pin", () => {
		const cache = createPiResourceBundleCache();
		const shared = createCanonicalPiResourceBundle([
			{ path: "settings.json", content: Buffer.from("{}") },
		]);
		const replacement = createCanonicalPiResourceBundle([
			{ path: "settings.json", content: Buffer.from('{"next":true}') },
		]);
		cache.put(shared);
		const first = createStartingLlmProcess(shared.digest);
		const second = createStartingLlmProcess(shared.digest, first.deps);
		const reconciler = createPiResourceBundlePinReconciler({ ...first.deps, bundleCache: cache });
		reconciler.reconcile(first.process);
		reconciler.reconcile(second.process);
		const nextStart = first.deps.turnStarts.create({
			...first.start,
			id: `${first.start.id}-next`,
			proposedTurnRecordId: "next-turn",
			state: {
				kind: "starting",
				start: { ...first.start.state.start, piResourceSnapshotDigest: replacement.digest },
			},
		});
		first.deps.processes.update(first.process.id, {
			currentExecution: { kind: "worker_start", id: nextStart.id },
		});
		const process = first.deps.processes.getById(first.process.id);
		if (!process) throw new Error("Expected process");
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(reconciler.reconcile(process)).toEqual({ missingDigest: replacement.digest });
			expect(cache.stats().pins).toBe(1);
		}
		expect(cache.gc().removedDigests).toEqual([]);
		cache.put(replacement);
		expect(reconciler.reconcile(process)).toEqual({ missingDigest: null });
		expect(cache.stats().pins).toBe(2);
	});
});
