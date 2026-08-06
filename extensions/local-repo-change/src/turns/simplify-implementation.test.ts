import { buildSimplifyImplementationPrompt } from "@leitwerk-dev/coding/turns/simplify-implementation";
import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { createFlowPromptContext } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { localRepoChangeProcess } from "../process-definition.js";

describe("buildSimplifyImplementationPrompt", () => {
	it("asks only for a read-only simplification review", () => {
		const workerCtx = createTestWorkerProcessContext({
			process: createTestProcessInstance({ processId: localRepoChangeProcess.id }),
			projects: [
				createTestProcessProject({
					key: "repo",
					baseBranch: "main",
					workBranch: "feature/test",
				}),
			],
			params: {
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Original requested change that must not be repeated.",
			},
			state: localRepoChangeProcess.initialState({
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Original requested change that must not be repeated.",
			}),
			turnResultMarkdownByProduct: {
				plan: "## Original implementation plan that must not be repeated",
			},
		});

		const prompt = buildSimplifyImplementationPrompt(createFlowPromptContext(workerCtx, []));

		expect(prompt).toContain("Repository root: . (the current working directory)");
		expect(prompt).toContain("Find worthwhile ways to simplify");
		expect(prompt).toContain("Inspect the repository read-only");
		expect(prompt).not.toContain("Original requested change");
		expect(prompt).not.toContain("Original implementation plan");
	});
});
