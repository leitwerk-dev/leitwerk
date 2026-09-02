import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createToolApprovalGate } from "./tool-approval-gate.js";

describe("tool approval gate", () => {
	it("does not reuse approval for a different tool call in the same turn", async () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const process = repos.processes.create({ processId: "approval_process" });
		const turnRecord = repos.turnRecords.create({
			id: "turn-1",
			instanceId: process.id,
			turnId: "run",
			turnType: "human",
			status: "succeeded",
			pathType: "primary",
		});
		const gate = createToolApprovalGate({
			repos,
			processOperations: createProcessOperationCoordinator(),
		});
		const first = gate.review({
			instanceId: process.id,
			turnRecordId: turnRecord.id,
			toolCallId: "call-1",
			toolName: "dangerous_tool",
			arguments: { value: 1 },
		});
		const request = repos.toolApprovalRequests.listByInstance(process.id)[0];
		if (!request) throw new Error("Expected approval request");

		await gate.resolve(
			process.id,
			request.id,
			{ kind: "accepted" },
			{
				id: "operator",
				kind: "user",
				provider: null,
			},
		);
		await expect(first).resolves.toEqual({ kind: "accepted" });

		const second = gate.review({
			instanceId: process.id,
			turnRecordId: turnRecord.id,
			toolCallId: "call-2",
			toolName: "dangerous_tool",
			arguments: { value: 2 },
		});
		expect(repos.toolApprovalRequests.listByInstance(process.id)).toHaveLength(2);

		gate.cancelTurn(process.id, turnRecord.id);
		await expect(second).resolves.toEqual({ kind: "declined" });
	});
});
