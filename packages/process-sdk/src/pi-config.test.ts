import { homedir } from "node:os";
import { llmTurn } from "@leitwerk-dev/process-sdk";
import { createTestConfigSnapshot } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import {
	collectProcessAvailableToolNames,
	createTemplateContext,
	expandPiAgentDir,
	interpolateTemplate,
	resolvePiAgentDir,
	resolveProcessPiConfig,
	resolveTurnActiveToolNames,
	validatePiBuiltInToolArray,
} from "./pi-config.js";

const testConfigSnapshot = createTestConfigSnapshot;

function testLlmTurn(
	availableTools: readonly ("read" | "bash" | "edit" | "write" | "grep" | "find" | "ls")[],
) {
	return llmTurn({
		description: "Test turn",
		availableTools,
		completionMode: "turn_end",
		branchType: "primary",
		context: "fresh",
		prompt: async () => "prompt",
		outcomes: {
			done: { description: "Done", parameters: {} },
		},
	});
}

describe("template-utils", () => {
	it("interpolates scalar runtime values into process prompt templates and derives process tools from turns", () => {
		const resolved = resolveProcessPiConfig({
			processId: "demo_process",
			processPiConfig: {
				systemPromptTemplate: "You are working on {{projectName}} from {{{repositoryUrl}}}",
				appendSystemPromptTemplate: "Current turn: {{selectedTurnId}}",
			},
			turns: [
				{ definition: testLlmTurn(["read", "grep"]) },
				{ definition: testLlmTurn(["bash", "write", "read"]) },
			],
			templateContext: createTemplateContext({
				params: { projectName: "leitwerk" },
				process: { selectedTurnId: "implement" },
				projects: [
					{ key: "app", repoLocator: "https://example.test/repo.git", baseBranch: "main" },
				],
			}),
		});

		expect(resolved).toMatchObject({
			systemPrompt: "You are working on leitwerk from https://example.test/repo.git",
			appendSystemPrompt: "Current turn: implement",
			availableToolNames: ["read", "bash", "write", "grep"],
		});
	});

	it("resolves a code-defined Pi session working directory from runtime params", () => {
		const resolved = resolveProcessPiConfig({
			processId: "demo_process",
			processPiConfig: { sessionCwdTemplate: "{{{workingDirectory}}}" },
			templateContext: createTemplateContext({
				params: { workingDirectory: "/tmp/recovery-target" },
			}),
		});

		expect(resolved.sessionCwd).toBe("/tmp/recovery-target");
	});

	it("collects process available tools as a canonical union of LLM turn tools", () => {
		expect(
			collectProcessAvailableToolNames([
				{ definition: testLlmTurn(["ls", "read"]) },
				{ definition: testLlmTurn(["read", "edit", "find"]) },
			]),
		).toEqual(["read", "edit", "find", "ls"]);
	});

	it("uses the current turn's available tools as active tools", () => {
		const reviewTurn = testLlmTurn(["read", "grep", "find"]);

		expect(
			resolveTurnActiveToolNames({
				turnId: "review",
				turnDef: reviewTurn,
			}),
		).toEqual(["read", "grep", "find"]);
	});

	it("rejects non-canonical Pi tool names with surrounding whitespace", () => {
		expect(validatePiBuiltInToolArray([" read "], "LLM turn 'review' availableTools")).toEqual(
			expect.arrayContaining([expect.stringContaining("without surrounding whitespace")]),
		);

		expect(() =>
			resolveTurnActiveToolNames({
				turnId: "review",
				turnDef: {
					...testLlmTurn(["read"]),
					availableTools: ["read", " read "] as never,
				},
			}),
		).toThrow(/without surrounding whitespace/);
		expect(() =>
			collectProcessAvailableToolNames([
				{
					definition: {
						...testLlmTurn(["read"]),
						availableTools: ["read", " read "] as never,
					},
				},
			]),
		).toThrow(/without surrounding whitespace/);
	});

	it("uses Mustache semantics for missing values, escaping, raw values, and nested keys", () => {
		expect(
			interpolateTemplate("Hello {{missing}} {{name}} {{{url}}} {{project.key}}", {
				name: "<agent>",
				url: "https://example.test/repo.git",
				project: { key: "APP" },
			}),
		).toBe("Hello  &lt;agent&gt; https://example.test/repo.git APP");
	});

	it("uses a built-in default system prompt aligned to derived process tools", () => {
		const resolved = resolveProcessPiConfig({
			processId: "demo_process",
			turns: [{ definition: testLlmTurn(["read", "grep"]) }],
			templateContext: createTemplateContext({}),
		});

		expect(resolved.systemPrompt).toContain(
			"You are an expert coding assistant operating inside pi",
		);
		expect(resolved.systemPrompt).toContain("- read: Read file contents");
		expect(resolved.systemPrompt).toContain("- grep: Search file contents");
		expect(resolved.systemPrompt).not.toContain("- bash:");
		expect(resolved.systemPrompt).toContain("Guidelines:");
	});

	it("prioritizes process-level template over config-level and built-in default", () => {
		const resolved = resolveProcessPiConfig({
			processId: "demo_process",
			processPiConfig: {
				systemPromptTemplate: "{{projectName}} process prompt",
			},
			configSnapshot: testConfigSnapshot(),
			templateContext: createTemplateContext({ params: { projectName: "my-project" } }),
		});

		expect(resolved.systemPrompt).toBe("my-project process prompt");
	});

	it("prioritizes config-level template over built-in default", () => {
		const configSnapshot = testConfigSnapshot();
		configSnapshot.pi.system_prompt_template = "{{projectKey}} global prompt";

		const resolved = resolveProcessPiConfig({
			processId: "demo_process",
			configSnapshot,
			templateContext: createTemplateContext({ params: { projectKey: "APP" } }),
		});

		expect(resolved.systemPrompt).toBe("APP global prompt");
	});

	it("prioritizes process-level template over config-level when both are set", () => {
		const configSnapshot = testConfigSnapshot();
		configSnapshot.pi.system_prompt_template = "config-level prompt";

		const resolved = resolveProcessPiConfig({
			processId: "demo_process",
			processPiConfig: { systemPromptTemplate: "process-level prompt" },
			configSnapshot,
			templateContext: createTemplateContext({}),
		});

		expect(resolved.systemPrompt).toBe("process-level prompt");
	});
});

describe("resolvePiAgentDir", () => {
	it("expands agent dirs with Pi-compatible tilde semantics", () => {
		expect(expandPiAgentDir("~")).toBe(homedir());
		expect(expandPiAgentDir("~/managed")).toBe(`${homedir()}/managed`);
		expect(expandPiAgentDir("relative/pi-agent")).toBe("relative/pi-agent");
	});

	it("prefers explicit agent dir, then config snapshot, then fallback", () => {
		const configSnapshot = testConfigSnapshot();
		configSnapshot.pi.agent_dir = "~/leitwerk-managed";

		expect(
			resolvePiAgentDir({
				agentDir: "/explicit/pi-agent",
				configSnapshot,
				fallbackDir: "/fallback",
			}),
		).toBe("/explicit/pi-agent");
		expect(resolvePiAgentDir({ configSnapshot, fallbackDir: "/fallback" })).toBe(
			`${homedir()}/leitwerk-managed`,
		);
		expect(resolvePiAgentDir({ fallbackDir: "/current/dir" })).toBe("/current/dir");
	});
});
