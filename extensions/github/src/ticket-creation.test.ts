import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubClient } from "./client.js";
import { registerGitHubTicketCreation } from "./ticket-creation.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
	"metadata",
	"labels",
	"label reconciliation",
])("does not start label or issue writes after cancellation during %s", async (stage) => {
	const controller = new AbortController();
	const waiting = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let pendingSignal: AbortSignal | null | undefined;
	let labelReads = 0;
	let writesStarted = 0;
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		const pathname = new URL(url).pathname;
		if (pathname.endsWith("/labels") && init?.method !== "POST") labelReads++;
		if (
			(stage === "metadata" && pathname.endsWith("/repositories/42")) ||
			(stage === "labels" && labelReads === 1) ||
			(stage === "label reconciliation" && labelReads === 2)
		) {
			pendingSignal = init?.signal;
			waiting.resolve();
			await release.promise;
		}
		if (init?.method === "POST") {
			writesStarted++;
			return Response.json({ id: 1, name: "created-by-leitwerk", number: 7 });
		}
		if (pathname.endsWith("/repositories/42"))
			return Response.json({
				id: 42,
				name: "garden",
				full_name: "team/garden",
				owner: { login: "team" },
				has_issues: true,
			});
		return Response.json([]);
	});
	const writes = createInMemoryExternalWriteLog();
	const { api, tools } = createToolCollector(writes);
	const client = new GitHubClient({
		apiBaseUrl: "https://github.test",
		token: "test",
		botLogin: "bot",
	});
	registerGitHubTicketCreation(
		api,
		{ profiles: () => ["local"], client: () => client },
		{ enabled: true, defaultLabels: ["created-by-leitwerk"] },
	);
	const tool = tools.get("github_create_issue");
	if (!tool) throw new Error("Missing GitHub ticket tool");
	const context = {
		process: { id: "ticket" },
		idempotencyKey: "ticket-write",
		signal: controller.signal,
		ticketDestination: {
			summary: { id: "local.42", displayName: "team/garden" },
			data: {
				profile: "local",
				baseUrl: "https://github.test",
				repositoryId: 42,
				owner: "team",
				repo: "garden",
				defaultLabels: ["created-by-leitwerk"],
			},
		},
	} as IntegrationToolExecutionContext;
	const rejected = expect(
		tool.execute(context, { title: "Review the garden", body: "Include weekly reminders." }),
	).rejects.toThrow();
	await waiting.promise;
	controller.abort();
	expect(pendingSignal?.aborted).toBe(true);
	release.resolve();
	await rejected;
	expect(writesStarted).toBe(0);
	expect(writes.records).toEqual([]);
});
