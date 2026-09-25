import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionInspectionCapture } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { ingestExecutionInspection } from "../supervisor/execution-inspection-ingestor.js";
import { createOwnedDatabaseScope } from "../test-helpers/owned-test-deps.js";
import { closeDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";

const { createDatabase, closeOwnedSqlite } = createOwnedDatabaseScope();

const modelInput: ExecutionInspectionCapture = {
	id: "call-1",
	version: 1,
	timestamp: "2026-09-25T08:00:00Z",
	fact: {
		kind: "model_input",
		boundaryEntryId: "prompt-1",
		model: { provider: "synthetic", id: "model-a", thinkingLevel: "off" },
		systemPrompt: { state: "recorded", value: "Recorded instructions" },
		appendedInstructions: { state: "recorded", value: ["Be precise"] },
		contextFiles: {
			state: "recorded",
			value: [{ path: "/workspace/AGENTS.md", content: "Recorded context" }],
		},
		tools: {
			state: "recorded",
			value: [{ name: "lookup", description: "Read evidence", parameters: { type: "object" } }],
		},
		messages: [
			{ entryId: "prompt-1", role: "user", content: { state: "recorded", value: "The request" } },
		],
	},
};

describe("execution inspection storage", () => {
	it.each([
		"startup",
		"operator SQL",
	])("preserves file-backed records through %s migration, replay and restart", (mode) => {
		const root = mkdtempSync(join(tmpdir(), "leitwerk-inspection-"));
		try {
			const sqlitePath = join(root, "state.sqlite");
			let db = createDatabase({ sqlitePath });
			let repos = createAllRepos(db);
			const process = repos.processes.create({
				processId: "synthetic",
				stateJson: '{"retained":true}',
			});
			const start = repos.turnStarts.create({
				instanceId: process.id,
				turnId: "investigate",
				turnType: "llm",
				proposedTurnRecordId: "historical-record",
				startKind: "selected_turn",
				recoveryTurnRecordId: null,
				continuation: null,
				state: {
					kind: "starting",
					start: {
						kind: "llm",
						model: {
							profileId: "test",
							providerId: "synthetic",
							modelId: "model-a",
							thinkingLevel: "off",
						},
						providerOptions: {},
						providerWorkerConfig: null,
						piResourceSnapshotDigest: "digest",
						workerRuntimeProfileId: "local",
						piSettings: {},
					},
				},
			});
			const lease = repos.leases.create({
				instanceId: process.id,
				workerId: "historical-worker",
				turnStartRecordId: start.id,
				state: "busy",
			});
			const record = repos.turnRecords.create({
				id: "historical-record",
				instanceId: process.id,
				turnId: "investigate",
				turnType: "llm",
				turnStartRecordId: start.id,
				acceptedWorkerLeaseId: lease.id,
			});
			repos.events.create({
				instanceId: process.id,
				eventType: "pi.stream.delta",
				data: { turnRecordId: record.id, text: "Crash evidence", streamType: "thinking" },
			});
			db.$client.exec("DROP TABLE execution_inspections; DROP TABLE inspection_contents;");
			if (mode === "operator SQL") {
				db.$client.exec(
					readFileSync(
						new URL("../../migrations/20260925_add_execution_inspections.sql", import.meta.url),
						"utf8",
					),
				);
				initializeSchema(db.$client);
			}
			closeDatabase(db);
			db = createDatabase({ sqlitePath });
			repos = createAllRepos(db);
			expect(repos.processes.getById(process.id)?.stateJson).toBe('{"retained":true}');
			expect(repos.events.listByTurnRecord(process.id, record.id)[0]?.data.text).toBe(
				"Crash evidence",
			);
			expect(repos.executionInspections.list(process.id, record.id)).toEqual([]);
			const observed = {
				...modelInput,
				instanceId: process.id,
				turnRecordId: record.id,
				startRecordId: "start",
				workerLeaseId: "lease",
			};
			expect(repos.executionInspections.append(observed)).toBe("stored");
			expect(repos.executionInspections.append(observed)).toBe("replay");
			const countContents = () =>
				db.$client.prepare("SELECT count(*) AS count FROM inspection_contents").get()?.count;
			const count = countContents();
			repos.executionInspections.append({ ...observed, id: "call-2" });
			expect(countContents()).toBe(count);
			expect(() =>
				repos.executionInspections.append({
					...observed,
					fact: { kind: "entry_link", entryId: "different", piTurnId: "pi-1", role: "assistant" },
				}),
			).toThrow("different evidence");
			repos.processes.update(process.id, { defaultModelProfileId: "changed-after-execution" });
			closeDatabase(db);
			db = createDatabase({ sqlitePath });
			repos = createAllRepos(db);
			expect(
				repos.executionInspections.list(process.id, record.id).map((item) => item.fact),
			).toEqual([modelInput.fact, modelInput.fact]);
			expect(repos.executionInspections.list("other-process", record.id)).toEqual([]);
			if (mode === "startup")
				expect(readdirSync(join(root, "backups")).some((name) => name.endsWith(".bak"))).toBe(true);
			closeDatabase(db);
		} finally {
			closeOwnedSqlite();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts replacement lease evidence but rejects stale workers and cross-process sources", () => {
		const db = createDatabase({ sqlitePath: ":memory:" });
		try {
			const repos = createAllRepos(db);
			const process = repos.processes.create({ processId: "synthetic" });
			const other = repos.processes.create({ processId: "synthetic" });
			const start = repos.turnStarts.create({
				instanceId: process.id,
				turnId: "investigate",
				turnType: "llm",
				proposedTurnRecordId: "execution",
				startKind: "selected_turn",
				recoveryTurnRecordId: null,
				continuation: null,
				state: {
					kind: "starting",
					start: {
						kind: "llm",
						model: {
							profileId: "test",
							providerId: "synthetic",
							modelId: "model-a",
							thinkingLevel: "off",
						},
						providerOptions: {},
						providerWorkerConfig: null,
						piResourceSnapshotDigest: "digest",
						workerRuntimeProfileId: "local",
						piSettings: {},
					},
				},
			});
			const lease = repos.leases.create({
				instanceId: process.id,
				workerId: "worker-1",
				turnStartRecordId: start.id,
				state: "busy",
			});
			repos.turnRecords.create({
				id: "execution",
				instanceId: process.id,
				turnId: start.turnId,
				turnType: "llm",
				turnStartRecordId: start.id,
				acceptedWorkerLeaseId: lease.id,
			});
			const report = {
				instanceId: process.id,
				workerId: "worker-1",
				turnRecordId: "execution",
				capture: modelInput,
			};
			expect(ingestExecutionInspection(repos, report)).toBe(true);
			repos.leases.update(lease.id, { exitedAt: new Date().toISOString(), state: "exited" });
			repos.leases.create({
				instanceId: process.id,
				workerId: "worker-2",
				turnStartRecordId: start.id,
				state: "busy",
			});
			expect(ingestExecutionInspection(repos, report)).toBe(false);
			expect(
				ingestExecutionInspection(repos, {
					...report,
					workerId: "worker-2",
					capture: { ...modelInput, id: "call-2" },
				}),
			).toBe(true);
			const producer = repos.turnRecords.create({
				instanceId: other.id,
				turnId: "publish",
				turnType: "human",
				resultPiEntryId: "foreign-entry",
			});
			expect(
				ingestExecutionInspection(repos, {
					...report,
					workerId: "worker-2",
					capture: {
						...modelInput,
						id: "supplied",
						fact: {
							kind: "supplied_context",
							origin: null,
							products: [
								{
									name: "plan",
									producerTurnRecordId: producer.id,
									entryId: "foreign-entry",
									content: { state: "recorded", value: "foreign" },
								},
							],
						},
					},
				}),
			).toBe(false);
			expect(repos.executionInspections.list(process.id, "execution")).toHaveLength(2);
		} finally {
			closeDatabase(db);
		}
	});
});
