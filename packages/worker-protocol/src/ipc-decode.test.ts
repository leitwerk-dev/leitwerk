import { describe, expect, it } from "vitest";
import { deserializeMessage, IPC_PROTOCOL_VERSION, serializeMessage } from "./ipc-codec.js";
import { decodeServerToWorkerMessage, decodeWorkerToServerMessage } from "./ipc-decode.js";
import { createIpcMessage } from "./ipc-messages.js";
import { createTestConfigSnapshot } from "./testing.js";

describe("ipc-decode", () => {
	it("decodes server-to-worker messages after envelope parsing", () => {
		const message = createIpcMessage({
			type: "worker.start",
			messageId: "m-start",
			instanceId: "agt_1",
			workerId: "wkr_1",
			payload: {
				workerLeaseId: "wls_1",
				turnStart: {
					id: "tsr_1",
					instanceId: "agt_1",
					turnId: "generate_plan",
					turnType: "llm",
					proposedTurnRecordId: "trn_1",
					startKind: "selected_turn",
					recoveryTurnRecordId: null,
					continuation: null,
					state: {
						kind: "starting",
						start: {
							kind: "llm",
							model: {
								profileId: "openai",
								providerId: "openai",
								modelId: "gpt",
								thinkingLevel: "low",
							},
							providerOptions: {},
							providerWorkerConfig: null,
							piResourceSnapshotDigest: "sha256:test",
							workerRuntimeProfileId: "local",
							piSettings: {},
						},
					},
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				bootstrap: {
					kind: "llm",
					resourceBundle: { digest: "sha256:test", archiveBase64: "dGFy" },
					credential: { providerId: "openai", revision: 1, values: { apiKey: "secret" } },
				},
				processSnapshot: {
					id: "agt_1",
					processId: "jira_issue_process",
					selectedTurnId: "generate_plan",
					lifecycleStatus: "active",
				},
				projectSnapshots: [
					{
						key: "backend",
						repoLocator: "https://example.com/backend.git",
						baseBranch: "main",
						workBranch: "feature/agt_1",
					},
				],
				pendingInputs: [
					{
						inputId: "inp_1",
						sequence: 1,
						source: "app_steer",
						kind: "instruction",
						target: null,
						receivedAt: "2026-01-01T00:00:00.000Z",
						bodyMarkdown: "Continue.",
					},
				],
				configSnapshot: createTestConfigSnapshot(),
				treePaths: {
					primaryTreeFile: "/tmp/session.jsonl",
					workspaceRoot: "/tmp/workspace",
				},
				resume: true,
				resumeLeafEntryId: "turn-1",
			},
		});
		const parsed = deserializeMessage(serializeMessage(message).trimEnd());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		const decoded = decodeServerToWorkerMessage(parsed.message);
		expect(decoded).toEqual({ ok: true, message });
		if (!decoded.ok) {
			return;
		}
		expect(decoded.message.type).toBe("worker.start");
		if (decoded.message.type !== "worker.start") {
			return;
		}
		expect(decoded.message.payload.treePaths.workspaceRoot).toBe("/tmp/workspace");
		expect(decoded.message.payload.resumeLeafEntryId).toBe("turn-1");
	});

	it("narrows turn-start acceptance and credential-update frames", () => {
		const accepted = createIpcMessage({
			type: "worker.turn_start_accepted",
			messageId: "m-accepted",
			instanceId: "agt_1",
			workerId: "wkr_1",
			payload: { startRecordId: "tsr_1", turnRecordId: "trn_1" },
		});
		const update = createIpcMessage({
			type: "worker.credential_update",
			messageId: "m-credential",
			instanceId: "agt_1",
			workerId: "wkr_1",
			payload: { providerId: "openai", expectedRevision: 1, values: { apiKey: "secret" } },
		});
		expect(decodeServerToWorkerMessage(accepted).ok).toBe(true);
		expect(decodeWorkerToServerMessage(update).ok).toBe(true);
	});

	it("decodes worker-to-server messages after envelope parsing", () => {
		const message = createIpcMessage({
			type: "worker.turn_outcome",
			messageId: "m-outcome",
			instanceId: "agt_1",
			workerId: "wkr_1",
			payload: {
				turnRecordId: "trn_1",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "done",
				params: { plan: "Ship it" },
				pathType: "primary",
				forkPiEntryId: "node_1",
				resultPiEntryId: "node_2",
			},
		});
		const parsed = deserializeMessage(serializeMessage(message).trimEnd());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		const decoded = decodeWorkerToServerMessage(parsed.message);
		expect(decoded).toEqual({ ok: true, message });
		if (!decoded.ok) {
			return;
		}
		expect(decoded.message.type).toBe("worker.turn_outcome");
		if (decoded.message.type !== "worker.turn_outcome") {
			return;
		}
		expect(decoded.message.payload.params.plan).toBe("Ship it");
	});

	it("rejects envelopes whose type is unknown for the decode direction", () => {
		const decoded = decodeServerToWorkerMessage({
			protocol: IPC_PROTOCOL_VERSION,
			messageId: "m-unknown",
			type: "worker.hello",
			instanceId: "agt_1",
			workerId: "wkr_1",
			sentAt: "2026-01-01T00:00:00.000Z",
			payload: { version: "1.0.0", capabilities: [] },
		});
		expect(decoded).toEqual({
			ok: false,
			error: "unexpected server-to-worker message type: worker.hello",
		});
	});

	it.each([
		"review.proceed",
		"config.delta",
		"worker.shutdown",
	])("rejects removed server-to-worker message type %s", (type) => {
		const decoded = decodeServerToWorkerMessage({
			protocol: IPC_PROTOCOL_VERSION,
			messageId: "m-removed",
			type,
			instanceId: "agt_1",
			workerId: "wkr_1",
			sentAt: "2026-01-01T00:00:00.000Z",
			payload: {},
		});
		expect(decoded).toEqual({
			ok: false,
			error: `unexpected server-to-worker message type: ${type}`,
		});
	});
});
