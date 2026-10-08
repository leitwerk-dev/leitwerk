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
			parameters: {
				citation: { type: "string", description: "Evidence reference", required: true },
			},
		},
	},
	turnResultMarkdown: { mode: "outcome_tool_argument", parameterName: "markdown", required: true },
};

async function fixture(llm: FakeLlmProvider, turnDef = defaultTurnDef) {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-abort-turn-"));
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
	config.pi.model_profiles = [
		{ id: "test-profile", provider: "test-provider", model_id: "test-model" },
	];
	const piHandle = await new SdkPiTreeHandleFactory().createPrimaryTreeHandle({
		instanceId: "abort-turn-test",
		treeFile: path.join(root, "tree.jsonl"),
		workspaceRoot: root,
		resume: false,
		configSnapshot: config,
		modelProfileId: "test-profile",
	});
	onTestFinished(() => piHandle.close());
	const toolSession = createTurnOutcomeToolSession({ turnId: "plan", turnDef });
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
	const run = () => execute({ kind: "prompt", promptText: "Save the plan" });
	return { run, piHandle, toolSession, reportFailedTurn };
}

it("aborts in the real Pi loop without acknowledgement, further tools, or outcome recovery", async () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() =>
		llm.calls.length > 1
			? { content: "Unexpected extra model call" }
			: {
					content: "",
					toolCalls: [
						{ name: "abort_turn", arguments: { reason: "Pinned dependency cannot be downloaded" } },
						{
							name: "plan_saved",
							arguments: { citation: "captured", markdown: "Must not publish" },
						},
					],
				},
	);
	const f = await fixture(llm);
	await expect(f.run()).rejects.toThrow(
		"Turn aborted by LLM: Pinned dependency cannot be downloaded",
	);
	const [errorClass, reason, entryId] = f.reportFailedTurn.mock.calls[0];
	expect(errorClass).toBe("llm_error");
	expect(reason).toContain("Pinned dependency cannot be downloaded");
	expect(f.piHandle.getEntry(entryId ?? "")).toBeDefined();
	expect(f.reportFailedTurn).toHaveBeenCalledOnce();
	expect(f.toolSession.getCompletionState().selectedOutcome).toBeNull();
	expect(f.toolSession.getCompletionState().markdownState.publicationCount).toBe(0);
	expect(llm.calls).toHaveLength(1);
});
