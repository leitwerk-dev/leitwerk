import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { FakeLlmProvider } from "@leitwerk-dev/test-support";
import { createManualWorkerRuntimeScheduler } from "@leitwerk-dev/test-support/worker-testing";
import { createTestConfigSnapshot } from "@leitwerk-dev/worker-protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import { executeLogicalPromptPlan, type LogicalTurnPromptPlan } from "./logical-prompt-runner.js";
import { runMissingToolRecovery } from "./missing-tool-recovery-runner.js";
import { SdkPiTreeHandleFactory } from "./pi-adapter.js";
import {
	createTurnOutcomeToolSession,
	type ToolCompletionSnapshot,
} from "./turn-outcome-tool-session.js";

const defaultTurnDef: LlmTurnDefinition<"plan_saved", unknown, unknown> = {
	kind: "llm",
	description: "Save a grounded plan",
	availableTools: [],
	branchType: "primary",
	context: "fresh",
	prompt: () => "Save the plan",
	outcomes: {
		plan_saved: {
			description: "Submit the plan",
			parameters: { citation: { type: "string", required: true } },
		},
	},
	turnResultMarkdown: { mode: "outcome_tool_argument", parameterName: "markdown", required: true },
};

async function fixture(
	llm: FakeLlmProvider,
	turnDef = defaultTurnDef,
	validation?: (params: Record<string, unknown>) => string[],
) {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-outcome-recovery-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const answer = llm.respond(body);
		const toolCalls = answer.toolCalls?.map((call, index) => ({
			index,
			id: `call-${llm.calls.length}-${index}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.arguments) },
		}));
		const chunk = (delta: unknown, finishReason: string | null) =>
			`data: ${JSON.stringify({
				id: `completion-${llm.calls.length}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "test-model",
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			chunk({ role: "assistant", content: answer.content, tool_calls: toolCalls }, null) +
				chunk({}, toolCalls?.length ? "tool_calls" : "stop") +
				"data: [DONE]\n\n",
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const agentDir = path.join(root, "agent");
	const extensionDir = path.join(agentDir, "extensions", "test-provider");
	await mkdir(extensionDir, { recursive: true });
	await writeFile(path.join(agentDir, "auth.json"), "{}\n");
	await writeFile(
		path.join(extensionDir, "index.ts"),
		`export default function (pi) {
			pi.registerProvider("test-provider", {
				baseUrl: "http://127.0.0.1:${(server.address() as AddressInfo).port}/v1",
				apiKey: "test-key", api: "openai-completions",
				models: [{ id: "test-model", name: "Test model", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768, maxTokens: 1024 }]
			});
		}`,
	);
	const config = createTestConfigSnapshot();
	config.pi.agent_dir = agentDir;
	config.pi.default_model_profile = "test-profile";
	config.pi.model_profiles = [
		{ id: "test-profile", provider: "test-provider", model_id: "test-model" },
	];
	const piHandle = await new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
		instanceId: "outcome-recovery-test",
		treeFile: path.join(root, "tree.jsonl"),
		workspaceRoot: root,
		resume: false,
		configSnapshot: config,
		modelProfileId: "test-profile",
	});
	onTestFinished(() => piHandle.close());
	const validateOutcome = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
		validation
			? validation(params)
			: params.citation === "captured"
				? []
				: ["Use a captured citation"],
	);
	const toolSession = createTurnOutcomeToolSession({ turnId: "plan", turnDef, validateOutcome });
	const reportFailedTurn = vi.fn(
		async (_errorClass: string, message: string, _entryId: string | null) => {
			throw new Error(message);
		},
	);
	const execute = (
		plan: LogicalTurnPromptPlan,
		options?: { baseState?: ToolCompletionSnapshot<"plan_saved"> },
	) =>
		executeLogicalPromptPlan({
			plan,
			baseState: options?.baseState,
			turnId: "plan",
			turnRecordId: "plan-record",
			piHandle,
			turnDef,
			toolSession,
			scheduler: createManualWorkerRuntimeScheduler(),
			reportFailedTurn,
		});
	const run = async () => {
		const initialAttempt = await execute({ kind: "prompt", promptText: "Save the plan" });
		return runMissingToolRecovery({
			turnId: "plan",
			turnRecordId: "plan-record",
			piHandle,
			toolSession,
			initialAttempt,
			executeLogicalPromptPlan: execute,
		});
	};
	return { run, piHandle, validateOutcome, reportFailedTurn };
}

it("aborts in the real Pi loop without acknowledgement, further tools, or outcome recovery", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [
			{ name: "abort_turn", arguments: { reason: "Pinned dependency cannot be downloaded" } },
			{ name: "plan_saved", arguments: { citation: "captured", markdown: "Must not publish" } },
		],
	}));
	const f = await fixture(llm);
	await expect(f.run()).rejects.toThrow(
		"Turn aborted by LLM: Pinned dependency cannot be downloaded",
	);
	const [errorClass, reason, entryId] = f.reportFailedTurn.mock.calls[0];
	expect(errorClass).toBe("llm_error");
	expect(reason).toContain("Pinned dependency cannot be downloaded");
	expect(f.piHandle.getEntry(entryId ?? "")).toBeDefined();
	expect(f.reportFailedTurn).toHaveBeenCalledOnce();
	expect(f.validateOutcome).not.toHaveBeenCalled();
	expect(llm.calls).toHaveLength(1);
});

it.each([
	["business validation", { citation: "invented", markdown: "## Plan" }, "Use a captured citation"],
	["argument schema", { citation: { invalid: true }, markdown: "## Plan" }, "citation"],
	["result Markdown", { citation: "captured", markdown: "" }, "markdown"],
] as const)("bounds repeated %s rejections inside the real Pi tool loop", async (_kind, args, error) => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() =>
		llm.calls.length > 4
			? { content: "Unexpected extra model call" }
			: { content: "", toolCalls: [{ name: "plan_saved", arguments: args }] },
	);
	const f = await fixture(llm);
	const result = await f.run();
	expect(llm.calls).toHaveLength(3);
	expect(result.failure?.recoveryContext.failureCode).toBe("outcome_rejected");
	expect(result.failure?.recoveryContext.suggestedContinuePrompt).toContain(error);
	expect(result.finalAttempt.resolvedOutcome).toBeNull();
	expect(result.finalAttempt.completionState.markdownState.publicationCount).toBe(0);
	expect(
		f.piHandle.getEntry(result.finalAttempt.promptResult.resultEntryId ?? "")?.message,
	).toMatchObject({
		role: "toolResult",
		toolName: "plan_saved",
	});
	if (_kind === "argument schema") expect(f.validateOutcome).not.toHaveBeenCalled();
});

it("accepts a corrected submission and its acknowledgement after returning to recovery", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [{ name: "plan_saved", arguments: { citation: "invented", markdown: "Rejected" } }],
	}));
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [{ name: "plan_saved", arguments: { citation: "captured", markdown: "## Plan" } }],
	}));
	llm.onPrompt(() => ({ content: "done" }));
	const f = await fixture(llm);
	const result = await f.run();
	expect(llm.calls).toHaveLength(3);
	expect(llm.calls[1]).toContain("Use a captured citation");
	expect(result.failure).toBeUndefined();
	expect(result.finalAttempt.resolvedOutcome).toEqual({
		outcome: "plan_saved",
		params: { citation: "captured" },
	});
	expect(result.finalAttempt.completionState.markdownState.markdown).toBe("## Plan");
});

it("corrects a union submission through real Pi without publishing the rejected attempt", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [
			{
				name: "plan_saved",
				arguments: { action: { kind: "skip", text: "unwanted placeholder" }, markdown: "Rejected" },
			},
		],
	}));
	llm.onPrompt(() => ({
		content: "",
		toolCalls: [
			{ name: "plan_saved", arguments: { action: { kind: "skip" }, markdown: "Accepted" } },
		],
	}));
	llm.onPrompt(() => ({ content: "done" }));
	const turn = {
		...defaultTurnDef,
		outcomes: {
			plan_saved: {
				description: "Choose",
				strictSchema: true,
				parameters: {
					action: {
						description: "Action",
						required: true,
						anyOf: [
							{
								type: "object" as const,
								properties: { kind: { type: "string" as const, enum: ["skip"] } },
								required: ["kind"],
								additionalProperties: false,
							},
							{
								type: "object" as const,
								properties: {
									kind: { type: "string" as const, enum: ["write"] },
									text: { type: "string" as const },
								},
								required: ["kind", "text"],
								additionalProperties: false,
							},
						],
					},
				},
			},
		},
	};
	const f = await fixture(llm, turn, () => []);
	const result = await f.run();
	expect(result.failure).toBeUndefined();
	expect(result.finalAttempt.resolvedOutcome?.params).toEqual({ action: { kind: "skip" } });
	expect(result.finalAttempt.completionState.markdownState).toMatchObject({
		markdown: "Accepted",
		publicationCount: 1,
	});
	expect(f.validateOutcome).toHaveBeenCalledTimes(1);
	const request = JSON.parse(llm.calls[0]);
	const tool = request.tools.find(
		(item: { function: { name: string } }) => item.function.name === "plan_saved",
	).function;
	expect(tool.strict).toBe(true);
	expect(tool.parameters.properties.action.anyOf).toHaveLength(2);
	expect(tool.parameters.properties).not.toHaveProperty("resultSummary");
});
