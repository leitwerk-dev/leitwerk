import {
	coreHostCapabilities,
	emptyParamsCodec,
	flow,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	type ExtensionIntegrationProcess,
	type IntegrationToolCall,
} from "@leitwerk-dev/test-support/integration";
import { expect, onTestFinished } from "vitest";
import ticketCreation from "./index.js";

/** @internal */
export async function createTicketFixture(
	provider: LeitwerkExtensionModule,
	toolName: string,
	tools: () => IntegrationToolCall[],
	descriptionKey = "body",
) {
	let changeInstructions: (id: string, prompt: string) => void = () => {
		throw new Error("Parent not initialized");
	};
	const parentDefinition = flow
		.process<{ prompt: string }, Record<string, never>>("ticket_test_parent")
		.displayName("Ticket test parent")
		.entry("retained_result")
		.codecs({
			params: {
				parse: (raw) => ({
					prompt: String(
						(raw as { prompt?: string } | undefined)?.prompt ?? "Original instructions",
					),
				}),
				serialize: (value) => value,
			},
			state: emptyParamsCodec,
		})
		.initialState(() => ({}))
		.turn(
			flow
				.llm<{ prompt: string }, Record<string, never>>("retained_result")
				.description("Retained result")
				.buildPrompt((ctx) => ctx.params.prompt)
				.publish("saved")
				.complete(),
		)
		.server((api) =>
			api.action({
				id: "change_instructions",
				label: "Change instructions",
				executionMode: "side_effect",
				async execute(input, ctx) {
					changeInstructions(ctx.process.id, String(input.prompt));
				},
			}),
		)
		.define();
	const test = await createExtensionIntegrationHarness({
		extensions: [
			ticketCreation,
			{
				manifest: { id: "ticket-test-parent", version: "1" },
				setupCatalog(api) {
					api.registerProcess(parentDefinition);
				},
				setupServer(api) {
					const setup = api.require(coreHostCapabilities.serverSetup);
					if (Array.isArray(setup)) throw new Error("Expected one server setup capability");
					changeInstructions = (id, prompt) => {
						setup.processes.update(id, { paramsJson: JSON.stringify({ prompt }) });
					};
				},
			},
			provider,
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
			tools: tools(),
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
							[descriptionKey]: `${call.arguments[descriptionKey]}\n${"feedback" in result ? result.feedback : ""}`,
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
		turnId: "retained_result",
		execution: { status: "succeeded", outcome: "saved", markdown: "Review the documentation." },
	});
	const request = (key: string) =>
		test.request({
			method: "POST",
			url: `/api/processes/${parent.id}/ticket-creation`,
			headers: { "idempotency-key": key },
			payload: { toolName, artifact: retained.artifact, focus: { kind: "whole_result" } },
		});
	return {
		test,
		parent,
		request,
		async launch(key: string) {
			const response = await request(key);
			expect(response.statusCode, response.body).toBe(200);
			return response.json<{ childInstanceId: string }>().childInstanceId;
		},
		async approval(
			id: string,
		): Promise<ReturnType<ExtensionIntegrationProcess["snapshot"]>["approvals"][number]> {
			const snapshot = await test
				.process(id)
				.waitFor((snapshot) => snapshot.approvals.some((request) => request.status === "open"));
			const approval = snapshot.approvals.find((request) => request.status === "open");
			if (!approval) throw new Error("Missing approval");
			return approval;
		},
	};
}
