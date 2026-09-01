import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

describe("process tool approval request repository", () => {
	it("persists the approved destination separately from opaque tool arguments", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const process = repos.processes.create({ processId: "ticket_process" });
		repos.turnRecords.create({
			id: "turn-1",
			instanceId: process.id,
			turnId: "create",
			turnType: "human",
			status: "succeeded",
			pathType: "primary",
		});
		const destination = {
			id: "repo-1",
			displayName: "team/repo",
			group: "Tracker",
			description: "Default labels: bot",
		};
		const result = repos.toolApprovalRequests.createIdempotent({
			instanceId: process.id,
			turnRecordId: "turn-1",
			toolCallId: "call-1",
			toolName: "tracker_create_ticket",
			arguments: { title: "Ticket", destination: "adapter-owned argument" },
			destination,
		});

		expect(result.request.arguments).toEqual({
			title: "Ticket",
			destination: "adapter-owned argument",
		});
		expect(result.request.destination).toEqual(destination);
		expect(() =>
			repos.toolApprovalRequests.createIdempotent({
				instanceId: process.id,
				turnRecordId: "turn-1",
				toolCallId: "call-1",
				toolName: "tracker_create_ticket",
				arguments: { title: "Ticket", destination: "adapter-owned argument" },
				destination: { ...destination, displayName: "other/repo" },
			}),
		).toThrow(/different arguments/);
	});
});
