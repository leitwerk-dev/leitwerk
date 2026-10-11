import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	WORKER_IPC_SERVER_URL_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerDiagnosticPayload } from "../diagnostics.js";
import { createWorkerSessionSnapshotExchangeFromEnv } from "../session-snapshot-exchange.js";
import { classifyRuntimeError } from "../turn-execution-error.js";
import { nodeWorkerRuntimeScheduler } from "./adapters.js";
import { WorkerLiveResources } from "./bootstrap-session.js";
import { normalizeWorkerFailure } from "./failure-policy.js";

const roots: string[] = [];
async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-snapshot-failure-"));
	roots.push(root);
	return root;
}
function snapshotEnv(serverUrl: string): NodeJS.ProcessEnv {
	return { [WORKER_IPC_SERVER_URL_ENV]: serverUrl, [WORKER_SNAPSHOT_TOKEN_ENV]: "secret-token" };
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("mandatory snapshot transport diagnostics", () => {
	it("retains safe fetch causes across retries and the mandatory failure disposition", async () => {
		const treeFile = path.join(await createTempRoot(), "primary.jsonl");
		await writeFile(treeFile, "PRIVATE SNAPSHOT BODY");
		const cause = Object.assign(
			new Error(
				"https://secret-token@private-host/socket?token=secret-token PRIVATE SNAPSHOT BODY",
			),
			{ code: "ECONNREFUSED" },
		);
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("fetch secret-token failed", { cause });
		});
		const exchange = createWorkerSessionSnapshotExchangeFromEnv({
			env: snapshotEnv("http://private-host"),
			instanceId: "agt_1",
			workerId: "wkr_1",
			fetchImpl,
		});
		const diagnostics: WorkerDiagnosticPayload[] = [];
		const sleep = vi.fn(async () => {});
		const resources = new WorkerLiveResources({
			instanceId: "agt_1",
			sessionSnapshots: exchange,
			piFactory: {} as ConstructorParameters<typeof WorkerLiveResources>[0]["piFactory"],
			gitOps: {} as ConstructorParameters<typeof WorkerLiveResources>[0]["gitOps"],
			developmentTools: {} as ConstructorParameters<
				typeof WorkerLiveResources
			>[0]["developmentTools"],
			scheduler: { ...nodeWorkerRuntimeScheduler, sleep },
			progress: (value) => diagnostics.push(value),
			diagnosticTrace() {},
		});
		const error = await resources
			.uploadSnapshot({ kind: "llm", treeFile }, "before_turn_outcome", {
				turnRecordId: "trn_1",
				required: true,
			})
			.catch((error: unknown) => error);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls).toEqual([[100], [200]]);
		expect(diagnostics).toHaveLength(3);
		expect(diagnostics[0]?.details).toMatchObject({
			attempt: 1,
			reason: "before_turn_outcome",
			transport: {
				causes: [
					{ name: "Error" },
					{ name: "TypeError", parent: 0 },
					{ name: "Error", code: "ECONNREFUSED", parent: 1 },
				],
			},
		});
		expect(classifyRuntimeError(error).errorClass).toBe("infrastructure");
		const disposition = normalizeWorkerFailure({
			kind: "mandatory_snapshot",
			error,
			point: "before_turn_outcome",
			correlation: { turnRecordId: "trn_1", turnId: "generate_plan" },
		});
		expect(disposition.terminal).toMatchObject({
			kind: "turn_failed",
			payload: {
				errorClass: "infrastructure",
				failureDetails: {
					reason: "before_turn_outcome",
					transport: {
						causes: expect.arrayContaining([expect.objectContaining({ code: "ECONNREFUSED" })]),
					},
				},
			},
			park: { selectedTurnId: "generate_plan" },
		});
		expect(
			disposition.diagnostic?.message.match(/Mandatory session snapshot upload failed/g),
		).toHaveLength(1);
		expect(disposition.diagnostic?.details).toMatchObject({
			reason: "before_turn_outcome",
			transport: {
				causes: expect.arrayContaining([expect.objectContaining({ code: "ECONNREFUSED" })]),
			},
		});
		expect(JSON.stringify({ diagnostics, disposition })).not.toMatch(
			/secret-token|private-host|PRIVATE SNAPSHOT BODY|https/,
		);
	});
});
