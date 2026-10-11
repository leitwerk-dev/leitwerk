import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import {
	enforceStrictOutcomePayload,
	installStrictOutcomeSchemas,
} from "./strict-outcome-schema.js";

const tool = {
	name: "choose",
	description: "Choose",
	strictSchema: true,
	parameters: {
		type: "object",
		properties: { action: { anyOf: [{ type: "string" }, { type: "number" }] } },
		required: ["action"],
		additionalProperties: false,
	},
	execute: async () => ({}),
};

it.each(["openai-responses", "openai-completions"])("enforces only opted-in tools on %s", (api) => {
	const declaration = (name: string) => ({
		type: "function",
		name,
		parameters: { type: "object" },
		strict: false,
	});
	const raw = [declaration("choose"), declaration("ordinary")];
	const payload = {
		tools:
			api === "openai-completions"
				? raw.map((value) => ({ type: "function", function: value }))
				: raw,
	};
	const result = enforceStrictOutcomePayload(payload, api, [tool]) as typeof payload;
	const declarations =
		api === "openai-completions"
			? result.tools.map((value) => (value as { function: unknown }).function)
			: result.tools;
	expect(declarations[0]).toMatchObject({ strict: true, parameters: tool.parameters });
	expect(declarations[1]).toEqual(raw[1]);
	expect(payload.tools[0]).not.toEqual(result.tools[0]);
});

it("composes existing payload hooks and diagnoses unsupported APIs without changing their payload", async () => {
	const payload = { tools: [{ type: "function", name: "choose" }] };
	const previous = vi.fn(async (value) => ({ ...value, marker: "existing hook" }));
	const stream = vi.fn();
	const session = {
		agent: { onPayload: previous, streamFunction: stream },
	} as unknown as AgentSession;
	const emit = vi.fn();
	const restore = installStrictOutcomeSchemas(session, [tool], emit);
	expect(
		await session.agent.onPayload!(payload, { api: "openai-responses" } as never),
	).toMatchObject({ marker: "existing hook", tools: [{ strict: true }] });
	session.agent.streamFunction({ api: "anthropic-messages" } as never, { messages: [] });
	expect(emit).toHaveBeenCalledWith(
		expect.objectContaining({ code: "strict_outcome_schema_unsupported" }),
	);
	expect(enforceStrictOutcomePayload(payload, "anthropic-messages", [tool])).toBe(payload);
	restore();
	expect(session.agent.onPayload).toBe(previous);
	expect(session.agent.streamFunction).toBe(stream);
});
