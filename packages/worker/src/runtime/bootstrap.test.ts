import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import {
	shouldPreservePersistedLeafForActiveTurnResume,
	validateRepositoryCredentials,
} from "./bootstrap.js";

function acceptedTurnStart(turnRecordId: string): TurnStartRecord {
	return {
		id: "start-running",
		instanceId: "agt_test",
		turnId: "generate_plan",
		turnType: "llm",
		proposedTurnRecordId: turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: "test",
					providerId: "test",
					modelId: "test",
					thinkingLevel: "medium",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "digest",
				workerRuntimeProfileId: "default",
				piSettings: {},
			},
			turnRecordId,
			acceptedWorkerLeaseId: "lease-running",
		},
		createdAt: "",
		updatedAt: "",
	};
}

describe("validateRepositoryCredentials", () => {
	const credential = {
		projectKey: "repo",
		kind: "git_ssh" as const,
		credentialRef: "default",
		privateKey: "key",
		knownHosts: "host key",
	};

	it("requires delivered credentials to exactly match declared requirements", () => {
		expect(() =>
			validateRepositoryCredentials({
				credentials: [credential],
				requirements: [{ projectKey: "repo", kind: "git_ssh", credentialRef: "other" }],
				projectKeys: new Set(["repo"]),
			}),
		).toThrow("exactly satisfy");
		expect(() =>
			validateRepositoryCredentials({
				credentials: [credential],
				requirements: [{ projectKey: "repo", kind: "git_ssh", credentialRef: "default" }],
				projectKeys: new Set(["repo"]),
			}),
		).not.toThrow();
	});
});

describe("shouldPreservePersistedLeafForActiveTurnResume", () => {
	it("preserves the persisted leaf for resumed active turns without explicit recovery metadata", () => {
		expect(
			shouldPreservePersistedLeafForActiveTurnResume({
				processSnapshot: createTestProcessInstance({
					selectedTurnId: "generate_plan",
					currentExecution: { kind: "worker_start", id: "start-running" },
				}),
				payload: { resume: true, turnStart: acceptedTurnStart("trn_running") },
			}),
		).toBe(true);
	});

	it("does not preserve the persisted leaf for fresh worker starts", () => {
		expect(
			shouldPreservePersistedLeafForActiveTurnResume({
				processSnapshot: createTestProcessInstance({
					selectedTurnId: "generate_plan",
					currentExecution: { kind: "worker_start", id: "start-running" },
				}),
				payload: { resume: false, turnStart: acceptedTurnStart("trn_running") },
			}),
		).toBe(false);
	});

	it("does not preserve the persisted leaf when an explicit continue leaf is present", () => {
		expect(
			shouldPreservePersistedLeafForActiveTurnResume({
				processSnapshot: createTestProcessInstance({
					selectedTurnId: "generate_plan",
					currentExecution: { kind: "worker_start", id: "start-running" },
					metadata: { continueFromPiEntryId: "assistant-failed-1" },
				}),
				payload: { resume: true, turnStart: acceptedTurnStart("trn_running") },
			}),
		).toBe(false);
	});

	it("does not preserve the persisted leaf when no running turn record exists", () => {
		expect(
			shouldPreservePersistedLeafForActiveTurnResume({
				processSnapshot: createTestProcessInstance({
					selectedTurnId: "generate_plan",
					currentExecution: { kind: "worker_start", id: "different-start" },
				}),
				payload: { resume: true, turnStart: acceptedTurnStart("trn_running") },
			}),
		).toBe(false);
	});
});

import type { TurnStartRecord } from "@leitwerk-dev/domain";
