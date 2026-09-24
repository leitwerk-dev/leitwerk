import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinPiServerAdapter } from "./builtin-server-adapter.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({
	getModel: vi.fn(),
	completeSimple: vi.fn(),
}));

const model = { id: "gpt-test", baseUrl: "https://api.openai.com/v1" };

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
		vi.clearAllMocks();
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
				config: { baseUrl: "  https://gateway.example.com/v1  " },
			}),
		).toBe("Generated title");
		expect(completeSimple).toHaveBeenCalledWith(
			{ ...model, baseUrl: "https://gateway.example.com/v1" },
			{
				systemPrompt: "Return a title",
				messages: [{ role: "user", content: "Name this process", timestamp: expect.any(Number) }],
			},
			expect.objectContaining({
				apiKey: "secret",
				maxTokens: 32,
				reasoning: "high",
				maxRetryDelayMs: 1_000,
			}),
		);
	});

	it.each([
		{},
		{ baseUrl: "   " },
	])("keeps the canonical model when no provider base URL is configured", async (config) => {
		const adapter = createBuiltinPiServerAdapter("openai");
		await adapter.generateText({ ...request, config });

		expect(completeSimple).toHaveBeenCalledWith(model, expect.any(Object), expect.any(Object));
	});

	it("uses an explicitly configured model absent from the built-in catalog", async () => {
		vi.mocked(getModel).mockReturnValue(undefined as never);
		const configured = {
			...model,
			provider: "openai",
			id: "new-deployment",
			api: "openai-responses",
			name: "New deployment",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		await createBuiltinPiServerAdapter("openai").generateText({
			...request,
			modelId: "new-deployment",
			thinkingLevel: "xhigh",
			config: { models: [configured] },
		});
		expect(completeSimple).toHaveBeenCalledWith(
			configured,
			expect.any(Object),
			expect.objectContaining({ reasoning: "xhigh" }),
		);
		await expect(
			createBuiltinPiServerAdapter("openai").generateText({
				...request,
				modelId: "new-deployment",
				config: { models: [{ ...configured, provider: "other" }] },
			}),
		).rejects.toThrow("unavailable");
	});
});
