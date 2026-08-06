import { buildReviewImplementationPrompt } from "@leitwerk-dev/coding/turns/review-implementation";
import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { createFlowPromptContext } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { localRepoChangeProcess } from "../process-definition.js";

describe("buildReviewImplementationPrompt", () => {
	it("includes current repository context without repeating the plan", () => {
		const workerCtx = createTestWorkerProcessContext({
			process: createTestProcessInstance({ processId: localRepoChangeProcess.id }),
			projects: [
				createTestProcessProject({
					key: "repo",
					baseBranch: "sentinel-review-base",
					workBranch: "feature/test",
				}),
			],
			params: {
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "SENTINEL_REQUEST_TO_REVIEW",
			},
			state: localRepoChangeProcess.initialState({
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "SENTINEL_REQUEST_TO_REVIEW",
			}),
			turnResultMarkdownByProduct: { plan: "SENTINEL_PLAN_MUST_NOT_BE_INCLUDED" },
		});
		const prompt = buildReviewImplementationPrompt(createFlowPromptContext(workerCtx, []));

		expect(prompt).toContain("sentinel-review-base");
		expect(prompt).toContain("SENTINEL_REQUEST_TO_REVIEW");
		expect(prompt).not.toContain("SENTINEL_PLAN_MUST_NOT_BE_INCLUDED");
	});
});
