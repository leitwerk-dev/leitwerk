import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	ExternalWriteLogRecordInput,
	ExternalWriteLogRepoLike,
} from "@leitwerk-dev/external-writes";
import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { expect, test } from "vitest";
import { LocalTicketAdapter } from "./testing.js";

test("restarts after persistence, reconciles the original write key, and records exactly one receipt", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "local-ticket-"));
	try {
		const options = {
			file: path.join(directory, "tickets.json"),
			baseUrl: "http://127.0.0.1:19082",
			destinations: [
				{ id: "garden", displayName: "Garden" },
				{ id: "workshop", displayName: "Workshop" },
			],
		};
		const records: ExternalWriteLogRecordInput[] = [];
		let writeLogAvailable = false;
		const writes: ExternalWriteLogRepoLike = {
			hasDedupKey: (key) => records.some((r) => r.dedupKey === key),
			record: (record) => {
				if (!writeLogAvailable) throw new Error("Write log unavailable after persistence");
				records.push(record);
			},
		};
		const adapter = new LocalTicketAdapter(options);
		const tool = adapter.tool(writes);
		const provider = tool.capability?.destinations;
		if (!provider) throw new Error("Missing destinations");
		const actor = { id: "local", kind: "user" as const, provider: null };
		expect((await provider.list({ actor })).destinations).toHaveLength(2);
		const snapshot = await provider.resolve({ actor, destinationId: "workshop" });
		await provider.validate(snapshot);
		const ctx = {
			process: { id: "child-1" },
			idempotencyKey: "stable-write-key",
			ticketDestination: snapshot,
		} as IntegrationToolExecutionContext;
		adapter.injectLostResponse();
		await expect(tool.execute(ctx, { title: "Review", body: "Review the notes" })).rejects.toThrow(
			/Write log unavailable/,
		);
		expect(records).toHaveLength(0);
		expect(JSON.parse(readFileSync(options.file, "utf8")).tickets).toHaveLength(1);
		const restarted = new LocalTicketAdapter(options);
		writeLogAvailable = true;
		const receipt = await restarted
			.tool(writes)
			.execute(ctx, { title: "Review", body: "Review the notes" });
		expect(
			await restarted.tool(writes).execute(ctx, { title: "Review", body: "Review the notes" }),
		).toEqual(receipt);
		expect(restarted.state.tickets).toHaveLength(1);
		expect(records).toEqual([
			expect.objectContaining({
				instanceId: "child-1",
				writeType: "local.create_ticket",
				dedupKey: "stable-write-key",
				metadata: receipt,
			}),
		]);
		expect(receipt).toMatchObject({
			externalId: "1",
			url: "http://127.0.0.1:19082/__local/tickets/1",
		});
		await expect(provider.validate({ ...snapshot, data: { id: "garden" } })).rejects.toThrow(
			/changed/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
