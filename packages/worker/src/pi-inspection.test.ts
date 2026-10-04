import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type ExecutionInspectionCapture, redactInspectionEvidence } from "@leitwerk-dev/domain";
import { FakeLlmProvider } from "@leitwerk-dev/test-support";
import { describe, expect, it } from "vitest";
import { installPiInspection } from "./pi-inspection.js";

describe("model-input capture", () => {
	it("retains each assembled context revision and exact message identities without provider options or renderer details", () => {
		const llm = new FakeLlmProvider();
		llm.onPrompt(() => ({ content: "done" }));
		const captures: ExecutionInspectionCapture[] = [];
		const entries = [
			{
				id: "prompt",
				type: "custom_message",
				content: "Request",
				details: { secretRendererState: "not model-facing" },
			},
		];
		let leaf = "prompt";
		const original = (_model: unknown, context: { messages: Array<{ content: unknown }> }) =>
			llm.respond(JSON.stringify(context.messages));
		const session = {
			agent: { streamFunction: original, subscribe: () => () => {} },
			thinkingLevel: "medium",
			sessionManager: { getBranch: () => entries, getLeafId: () => leaf },
			resourceLoader: {
				getAppendSystemPrompt: () => ["Be precise"],
				getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: "Context file" }] }),
			},
		};
		const release = installPiInspection(session as unknown as AgentSession, (capture) =>
			captures.push(capture),
		);
		const call = session.agent.streamFunction as unknown as AgentSession["agent"]["streamFunction"];
		const model = { provider: "synthetic", id: "first" } as Parameters<typeof call>[0];
		const lookup = {
			name: "lookup",
			description: "Available",
			parameters: { type: "object", properties: {} },
		};
		const finish = { ...lookup, name: "finish", description: "Finish the turn" };
		const request = { role: "user" as const, content: "Request", timestamp: 1 };
		const context: TranscriptContext = {
			messages: [
				{
					role: "system",
					content: "Base instructions",
					sections: { turn: "Assembled first", obsolete: "Obsolete instructions" },
					toolsAdded: [lookup],
					timestamp: 0,
				},
				request,
			],
		};
		call(model, context, { apiKey: "provider-secret" });
		leaf = "compaction";
		request.content = "Compacted history";
		context.messages.push({
			role: "system",
			content: "Additional instructions",
			sections: { turn: "Assembled second", obsolete: null },
			toolsRemoved: [{ name: "lookup" }],
			toolsAdded: [finish],
			timestamp: 2,
		});
		call({ ...model, id: "second" }, context, { apiKey: "provider-secret" });
		call(model, { messages: [request] }, { apiKey: "provider-secret" });
		expect(llm.calls).toHaveLength(3);
		expect(captures.map((capture) => capture.fact)).toMatchObject([
			{
				kind: "model_input",
				boundaryEntryId: "prompt",
				model: { id: "first" },
				systemPrompt: {
					state: "recorded",
					value: "Base instructions\n\nAssembled first\n\nObsolete instructions",
				},
				tools: { state: "recorded", value: [lookup] },
				messages: [
					{ entryId: null, role: "system", content: { value: "Base instructions" } },
					{ entryId: "prompt", role: "user", content: { value: "Request" } },
				],
			},
			{
				kind: "model_input",
				boundaryEntryId: "compaction",
				model: { id: "second" },
				systemPrompt: {
					state: "recorded",
					value: "Base instructions\n\nAdditional instructions\n\nAssembled second",
				},
				tools: { state: "recorded", value: [finish] },
				messages: [
					{ entryId: null, role: "system", content: { value: "Base instructions" } },
					{ entryId: null, role: "user", content: { value: "Compacted history" } },
					{ entryId: null, role: "system", content: { value: "Additional instructions" } },
				],
			},
			{
				kind: "model_input",
				systemPrompt: { state: "recorded", value: "" },
				tools: { state: "recorded", value: [] },
				messages: [{ entryId: null, role: "user", content: { value: "Compacted history" } }],
			},
		]);
		expect(JSON.stringify(captures)).not.toContain("provider-secret");
		expect(JSON.stringify(captures)).not.toContain("secretRendererState");
		release();
		expect(session.agent.streamFunction).toBe(original);
	});

	it("marks redacted evidence and keeps empty recorded fields distinct", () => {
		const safe = redactInspectionEvidence(
			{
				systemPrompt: { state: "recorded", value: "Do not repeat fake-token" },
				tools: { state: "recorded", value: [] },
			},
			(text) => text.replaceAll("fake-token", "<redacted>"),
		);
		expect(safe).toEqual({
			systemPrompt: { state: "redacted", value: "Do not repeat <redacted>" },
			tools: { state: "recorded", value: [] },
		});
	});
});
