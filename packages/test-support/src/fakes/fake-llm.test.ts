import { expect, it } from "vitest";
import { FakeLlmProvider } from "./fake-llm.js";

it("responds with the configured prompt handler", () => {
	const llm = new FakeLlmProvider();
	llm.onPrompt(() => ({ content: "plan: do something" }));
	expect(llm.respond("generate a plan").content).toBe("plan: do something");
});
