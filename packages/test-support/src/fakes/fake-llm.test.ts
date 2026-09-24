import { expect, it } from "vitest";
import { FakeLlmProvider } from "./fake-llm.js";

it("responds with the configured prompt handler", () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt((prompt) => ({ content: `plan: ${prompt}` }));
	expect(llm.respond("generate a plan").content).toBe("plan: generate a plan");
	expect(llm.calls).toEqual(["generate a plan"]);
});
