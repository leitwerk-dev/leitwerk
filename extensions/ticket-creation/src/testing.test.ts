import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { expect, onTestFinished, test, vi } from "vitest";
import { LocalTicketAdapter } from "./testing.js";

test("restarts after persistence, reconciles the original write key, and records exactly one receipt", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "local-ticket-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const options = {
		file: path.join(directory, "tickets.json"),
		baseUrl: "http://127.0.0.1:19082",
		destinations: [
			{ id: "garden", displayName: "Garden" },
			{ id: "workshop", displayName: "Workshop" },
		],
	};
	let writeLogAvailable = false;
	let adapter = new LocalTicketAdapter(options);
	const harness = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "ticket-adapter-test", version: "1" },
				setupServer(api) {
					const deps = api.get(coreHostCapabilities.serverSetup);
					if (!deps || Array.isArray(deps)) throw new Error("Missing server setup");
					const record = deps.externalWrites.record.bind(deps.externalWrites);
					vi.spyOn(deps.externalWrites, "record").mockImplementation((input) => {
						if (!writeLogAvailable) throw new Error("Write log unavailable after persistence");
						return record(input);
					});
					const tool = adapter.tool();
					api.tool({
						...tool,
						execute: (ctx, args) => adapter.tool().execute(ctx, args),
					});
				},
			},
		],
	});
	onTestFinished(() => harness.close());
	const name = harness.describeTools()[0].name;
	const actor = { id: "local", kind: "user" as const, provider: null };
	expect((await harness.listToolDestinations(name, actor)).destinations).toHaveLength(2);
	const snapshot = await harness.resolveToolDestination(name, "workshop", actor);
	await harness.validateToolDestination(name, snapshot);
	const fixture = { id: "child-1", invocationId: "stable-write-key", ticketDestination: snapshot };
	adapter.injectLostResponse();
	await expect(
		harness.callTool(name, { title: "Review", body: "Review the notes" }, fixture),
	).rejects.toMatchObject({
		name: "AggregateError",
		errors: [
			expect.objectContaining({ message: "Local ticket persisted, but its response was lost." }),
			expect.objectContaining({ message: "Write log unavailable after persistence" }),
		],
	});
	expect(harness.writeReceipts()).toHaveLength(0);
	expect(JSON.parse(readFileSync(options.file, "utf8")).tickets).toHaveLength(1);
	adapter = new LocalTicketAdapter(options);
	writeLogAvailable = true;
	const receipt = await harness.callTool(
		name,
		{ title: "Review", body: "Review the notes" },
		fixture,
	);
	expect(
		await harness.callTool(name, { title: "Review", body: "Review the notes" }, fixture),
	).toEqual(receipt);
	expect(adapter.state.tickets).toHaveLength(1);
	expect(harness.writeReceipts()).toEqual([
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
	await expect(
		harness.validateToolDestination(name, { ...snapshot, data: { id: "garden" } }),
	).rejects.toThrow(/changed/);
});
