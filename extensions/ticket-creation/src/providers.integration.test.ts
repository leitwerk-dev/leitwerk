import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupGitHubIntegration } from "@leitwerk-dev/github";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import { LocalGitLabAdapter, setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import jiraExtension, { setupJiraIntegration } from "@leitwerk-dev/jira";
import { LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { emptyParamsCodec, flow, type ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createExtensionIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { expect, it, onTestFinished } from "vitest";
import ticketCreation from "./index.js";

const providers = ["GitHub", "GitLab", "Jira"] as const;
type Provider = (typeof providers)[number];

function providerFixture(provider: Provider, root: string) {
	const options = { ticketCreation: { enabled: true, defaultLabels: ["created-by-leitwerk"] } };
	if (provider === "GitHub") {
		const adapter = new LocalGitHubAdapter({
			root,
			baseUrl: "https://github.test",
			seeds: [{ owner: "team", name: "garden" }],
		});
		return {
			setup: (api: ServerExtensionAPI) =>
				setupGitHubIntegration(
					api,
					{ profiles: () => ["local"], client: () => adapter.client() },
					options,
				),
			destinationId: `local.${adapter.repo("team", "garden").repository.id}`,
			args: { title: "Document the review", body: "Include the planting checklist." },
			descriptionKey: "body",
			issues: () => adapter.repo("team", "garden").issues,
			loseResponse: () => adapter.failNextResponse("create-issue"),
		};
	}
	if (provider === "GitLab") {
		const adapter = new LocalGitLabAdapter(root);
		const project = adapter.addProject("team/garden", path.join(root, "unused.git"));
		return {
			setup: (api: ServerExtensionAPI) =>
				setupGitLabIntegration(
					api,
					{ profiles: () => ["local"], client: () => adapter.client() },
					options,
				),
			destinationId: `local.${project.id}`,
			args: { title: "Document the review", description: "Include the planting checklist." },
			descriptionKey: "description",
			issues: () => adapter.state.issues ?? [],
			loseResponse: () => {
				adapter.loseNextIssueResponse = true;
			},
		};
	}
	const adapter = new LocalJiraAdapter(root, "https://jira.test/context");
	adapter.seed({
		id: "100",
		key: "GARDEN",
		name: "Garden",
		issuetypes: [
			{
				id: "10",
				name: "Task",
				subtask: false,
				fields: {
					summary: { name: "Summary", required: true },
					description: { name: "Description", required: false },
					labels: { name: "Labels", required: false },
					customfield_10001: { name: "Team", required: true, schema: { type: "string" } },
				},
			},
		],
	});
	return {
		setup: (api: ServerExtensionAPI) =>
			setupJiraIntegration(
				api,
				{ profiles: () => ["local"], client: () => adapter.client() },
				options,
			),
		destinationId: "local.100.10",
		args: {
			summary: "Document the review",
			description: "Include the planting checklist.",
			fields: { customfield_10001: "Gardeners" },
		},
		descriptionKey: "description",
		issues: () => adapter.state.issues,
		loseResponse: () => {
			adapter.loseNextIssueResponse = true;
		},
	};
}

async function fixture(provider: Provider) {
	const root = mkdtempSync(path.join(tmpdir(), "ticket-providers-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const boundary = providerFixture(provider, root);
	const toolName = `${provider.toLowerCase()}_create_issue`;
	const parentDefinition = flow
		.process("ticket_parent")
		.displayName("Garden review")
		.entry("review")
		.codecs({ params: emptyParamsCodec, state: emptyParamsCodec })
		.initialState(() => ({}))
		.turn(
			flow
				.llm("review")
				.description("Review the garden")
				.prompt("Review the garden")
				.publish("saved")
				.complete(),
		)
		.define();
	const test = await createExtensionIntegrationHarness({
		extensions: [
			ticketCreation,
			{
				manifest: { id: "parent", version: "1" },
				setupCatalog(api) {
					api.registerProcess(parentDefinition);
				},
			},
			{
				manifest: { id: provider.toLowerCase(), version: "1" },
				...(provider === "Jira" ? { scopedSettings: jiraExtension.scopedSettings } : {}),
				setupServer: boundary.setup,
			},
			{
				manifest: { id: "ticket-model", version: "1" },
				modelProviders: fixtureModelProviders({
					id: "ticket-model",
					modelId: "scripted",
					server: true,
				}),
			},
		],
		models: [{ id: "scripted", provider: "ticket-model", modelId: "scripted" }],
		defaultModel: "scripted",
		script: () => ({
			tools: [
				{ name: toolName, arguments: { ...boundary.args, destinationId: boundary.destinationId } },
			],
			afterToolResult(call, result) {
				if (
					result &&
					typeof result === "object" &&
					"code" in result &&
					result.code === "operator_feedback"
				)
					return {
						...call,
						arguments: {
							...call.arguments,
							[boundary.descriptionKey]: "Revised planting checklist with weekly reminders.",
						},
					};
			},
		}),
	});
	onTestFinished(() => test.close());
	const parent = await test.createProcess(parentDefinition, {
		position: { selectedTurnId: null, lifecycleStatus: "completed" },
	});
	const retained = await parent.seedAcceptedTurn({
		turnId: "review",
		execution: { status: "succeeded", outcome: "saved", markdown: "Document the planting review." },
	});
	const launch = () =>
		test.request({
			method: "POST",
			url: `/api/processes/${parent.id}/ticket-creation`,
			headers: { "idempotency-key": "one-ticket" },
			payload: {
				toolName,
				artifact: retained.artifact,
				focus: { kind: "whole_result" },
				additionalInstructions: "Create a garden issue.",
			},
		});
	const response = await launch();
	expect(response.statusCode, response.body).toBe(200);
	const child = test.process(response.json<{ childInstanceId: string }>().childInstanceId);
	const approval = async () => {
		const snapshot = await child.waitFor((snapshot) =>
			snapshot.approvals.some((request) => request.status === "open"),
		);
		const request = snapshot.approvals.find((request) => request.status === "open");
		if (!request) throw new Error("Missing approval");
		return request;
	};
	return { test, boundary, child, approval, launch, toolName };
}

it.each(
	providers,
)("%s reviews, revises, creates once after a lost response, and retains its receipt after restart", async (provider) => {
	const { test, boundary, child, approval, launch, toolName } = await fixture(provider);
	const catalog = await test.request({ method: "GET", url: "/api/ticket-creation/tools" });
	expect(catalog.json().tools).toContainEqual(
		expect.objectContaining({
			name: toolName,
			displayName: provider,
			titlePath: expect.any(String),
			descriptionPath: expect.any(String),
		}),
	);
	const first = await approval();
	expect(first.destination?.id).toBe(boundary.destinationId);
	expect(boundary.issues()).toHaveLength(0);
	await child.respondToApproval(first.id, {
		action: "feedback",
		feedback: "Add weekly reminders.",
	});
	const revised = await approval();
	expect(revised.arguments[boundary.descriptionKey]).toContain("weekly reminders");
	expect(boundary.issues()).toHaveLength(0);
	boundary.loseResponse();
	await child.respondToApproval(revised.id, { action: "accept" });
	const completed = await child.waitFor(
		(snapshot) => snapshot.process.lifecycleStatus === "completed",
	);
	expect(boundary.issues()).toHaveLength(1);
	expect(completed.process.externalId).toBeTruthy();
	expect(
		completed.writeReceipts.filter(
			(receipt) => receipt.writeType === `${provider.toLowerCase()}.create_issue`,
		),
	).toHaveLength(1);
	await test.restart();
	const replay = await launch();
	expect(replay.statusCode, replay.body).toBe(200);
	expect(replay.json().childInstanceId).toBe(child.id);
	expect(boundary.issues()).toHaveLength(1);
	expect(child.snapshot().writeReceipts).toEqual(completed.writeReceipts);
}, 20_000);

it.each(providers)("%s discards a draft without writing an issue or labels", async (provider) => {
	const { boundary, child, approval } = await fixture(provider);
	const request = await approval();
	await child.respondToApproval(request.id, { action: "decline" });
	const discarded = await child.waitFor(
		(snapshot) => snapshot.process.lifecycleStatus === "aborted",
	);
	expect(boundary.issues()).toHaveLength(0);
	expect(discarded.writeReceipts).toHaveLength(0);
}, 15_000);
