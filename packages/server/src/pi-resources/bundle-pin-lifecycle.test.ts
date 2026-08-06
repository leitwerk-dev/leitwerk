import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { createPiResourceBundleCache } from "./bundle-cache.js";
import { createPiResourceBundlePinReconciler } from "./bundle-pin-lifecycle.js";

describe("Pi resource bundle pin lifecycle", () => {
	it("pins only a current starting or accepted running LLM start", () => {
		const deps = createTestDeps();
		const cache = createPiResourceBundleCache();
		const bundle = createCanonicalPiResourceBundle([
			{ path: "settings.json", content: Buffer.from("{}") },
		]);
		cache.put(bundle);
		const process = deps.processes.create({
			processId: "p",
			selectedTurnId: "t",
			lifecycleStatus: "active",
		});
		const start = deps.turnStarts.create({
			instanceId: process.id,
			turnId: "t",
			turnType: "llm",
			proposedTurnRecordId: "tr",
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
					piResourceSnapshotDigest: bundle.digest,
					workerRuntimeProfileId: "local",
					piSettings: {},
				},
			},
		});
		deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
		const reconciler = createPiResourceBundlePinReconciler({ ...deps, bundleCache: cache });
		const activeProcess = deps.processes.getById(process.id);
		if (!activeProcess) throw new Error("Expected process");
		expect(reconciler.reconcile(activeProcess)).toEqual({
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
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "p",
			selectedTurnId: "t",
			lifecycleStatus: "active",
		});
		const start = deps.turnStarts.create({
			instanceId: process.id,
			turnId: "t",
			turnType: "llm",
			proposedTurnRecordId: "tr",
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
					piResourceSnapshotDigest: "missing",
					workerRuntimeProfileId: "local",
					piSettings: {},
				},
			},
		});
		deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
		const reconciler = createPiResourceBundlePinReconciler({
			...deps,
			bundleCache: createPiResourceBundleCache(),
		});
		const activeProcess = deps.processes.getById(process.id);
		if (!activeProcess) throw new Error("Expected process");
		expect(reconciler.reconcile(activeProcess)).toEqual({
			missingDigest: "missing",
		});
	});
});
