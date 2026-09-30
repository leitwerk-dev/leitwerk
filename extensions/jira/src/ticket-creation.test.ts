import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { describe, expect, it, onTestFinished } from "vitest";
import { JiraClient, type JiraClientLike } from "./client.js";
import { LocalJiraAdapter } from "./testing.js";
import { registerJiraTicketCreation } from "./ticket-creation.js";

const fields = {
	summary: { name: "Summary", required: true },
	description: { name: "Description", required: false },
};
const project = { id: "100", key: "GARDEN", name: "Garden" };
const issueType = { id: "10", name: "Task", subtask: false };
const args = { summary: "Review the garden", description: "Include weekly reminders." };

function setup(client: JiraClientLike, defaultLabels: string[] = []) {
	const writes = createInMemoryExternalWriteLog();
	const { api, tools } = createToolCollector(writes);
	registerJiraTicketCreation(
		api,
		{ profiles: () => ["local"], client: () => client },
		{ enabled: true, defaultLabels },
	);
	const tool = tools.get("jira_create_issue");
	if (!tool) throw new Error("Missing Jira ticket tool");
	const controller = new AbortController();
	const context = {
		process: { id: "ticket" },
		idempotencyKey: "ticket-write",
		signal: controller.signal,
		ticketDestination: {
			summary: { id: "local.100.10", displayName: "Garden / Task" },
			data: {
				profile: "local",
				baseUrl: client.baseUrl,
				projectId: "100",
				projectKey: "GARDEN",
				issueTypeId: "10",
				defaultLabels,
			},
		},
	} as IntegrationToolExecutionContext;
	return { tool, context, controller, writes };
}

function localFixture(defaultLabels: string[] = [], supportsLabels = false) {
	const root = mkdtempSync(path.join(tmpdir(), "jira-ticket-test-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const adapter = new LocalJiraAdapter(root);
	adapter.seed({
		...project,
		issuetypes: [
			{
				...issueType,
				fields: {
					...fields,
					...(supportsLabels ? { labels: { name: "Labels", required: false } } : {}),
				},
			},
		],
	});
	return { ...setup(adapter.client(), defaultLabels), adapter };
}

describe("Jira ticket creation", () => {
	it("creates without submitting Labels when the create screen excludes it", async () => {
		const { tool, context, adapter } = localFixture();
		await expect(tool.execute(context, args)).resolves.toMatchObject({ externalId: "GARDEN-1" });
		expect(adapter.state.issues).toHaveLength(1);
		expect(adapter.state.issues[0].fields.labels).toEqual([]);
	});

	it("rejects unsupported configured labels before presenting a destination for approval", async () => {
		const { tool, adapter, writes } = localFixture(["created-by-leitwerk"]);
		const destinations = tool.capability?.destinations;
		if (!destinations) throw new Error("Missing Jira destinations");
		await expect(
			destinations.resolve({
				destinationId: "local.100.10",
				actor: { id: "operator", kind: "user", provider: null },
			}),
		).rejects.toThrow("does not support labels");
		expect(adapter.state.issues).toEqual([]);
		expect(writes.records).toEqual([]);
	});

	it("rejects unsupported requested labels without writing", async () => {
		const { tool, context, adapter, writes } = localFixture();
		await expect(tool.execute(context, { ...args, labels: ["triage"] })).rejects.toThrow(
			"does not support labels",
		);
		expect(adapter.state.issues).toEqual([]);
		expect(writes.records).toEqual([]);
	});

	it("retains configured and requested labels when the screen supports them", async () => {
		const { tool, context, adapter } = localFixture(["created-by-leitwerk"], true);
		await tool.execute(context, { ...args, labels: ["triage"] });
		expect(adapter.state.issues[0].fields.labels).toEqual(["created-by-leitwerk", "triage"]);
	});

	it.each([
		"metadata",
		"reconciliation",
	])("does not start a write after cancellation during %s", async (stage) => {
		const waiting = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pendingSignal: AbortSignal | null | undefined;
		let writesStarted = 0;
		const client = new JiraClient(
			{ baseUrl: "https://jira.test", token: "test" },
			async (url, init) => {
				const pathname = new URL(String(url)).pathname;
				if (
					(stage === "metadata" && pathname.endsWith("/issuetypes/10")) ||
					(stage === "reconciliation" && pathname.endsWith("/search"))
				) {
					pendingSignal = init?.signal;
					waiting.resolve();
					await release.promise;
				}
				if (init?.method === "POST") {
					writesStarted++;
					return Response.json({ id: "7" });
				}
				if (pathname.endsWith("/project/100")) return Response.json(project);
				if (pathname.endsWith("/issuetypes"))
					return Response.json({ values: [issueType], last: true });
				if (pathname.endsWith("/issuetypes/10"))
					return Response.json({
						values: Object.entries(fields).map(([fieldId, field]) => ({ fieldId, ...field })),
						last: true,
					});
				if (pathname.endsWith("/search")) return Response.json({ issues: [], total: 0 });
				return Response.json({ id: "7", key: "GARDEN-7", fields: args });
			},
		);
		const { tool, context, controller, writes } = setup(client);
		const rejected = expect(tool.execute(context, args)).rejects.toThrow();
		await waiting.promise;
		controller.abort();
		expect(pendingSignal?.aborted).toBe(true);
		release.resolve();
		await rejected;
		expect(writesStarted).toBe(0);
		expect(writes.records).toEqual([]);
	});
});
