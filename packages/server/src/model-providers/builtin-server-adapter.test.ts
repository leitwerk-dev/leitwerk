import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinPiServerAdapter } from "./builtin-server-adapter.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({
	getModel: vi.fn(),
	completeSimple: vi.fn(),
}));

const model = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
};

const request = {
	providerId: "openai",
	modelId: "gpt-test",
	thinkingLevel: "high",
	prompt: "Name this process",
	systemPrompt: "Return a title",
	maxTokens: 32,
	config: {},
	options: {},
	secrets: { apiKey: "secret" },
	request: { maxRetryDelayMs: 1_000 },
};

describe("built-in Pi server adapter", () => {
	beforeEach(() => {
		vi.mocked(getModel).mockReturnValue(model as never);
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Generated title" }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
	});

	it("uses the configured provider base URL for server-side requests", async () => {
		const adapter = createBuiltinPiServerAdapter("openai");

		expect(
			await adapter.generateText({
				...request,
				config: { baseUrl: "https://gateway.example.com/v1" },
			}),
		).toBe("Generated title");
		expect(completeSimple).toHaveBeenCalledWith(
			{ ...model, baseUrl: "https://gateway.example.com/v1" },
			expect.any(Object),
			expect.objectContaining({ apiKey: "secret" }),
		);
	});

	it("keeps the catalog endpoint when no provider base URL is configured", async () => {
		const adapter = createBuiltinPiServerAdapter("openai");
		await adapter.generateText(request);

		expect(completeSimple).toHaveBeenCalledWith(model, expect.any(Object), expect.any(Object));
	});
});
