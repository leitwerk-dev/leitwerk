import { describe, expect, it } from "vitest";
import { repositoryChangeStateCodec } from "./repository-change-state.js";

describe("repositoryChangeStateCodec", () => {
	it("ignores obsolete LLM commit checkpoints in legacy state", () => {
		const state = repositoryChangeStateCodec.parse({
			finalization: {
				expectedPreCommitHeadSha: "before",
				expectedPostCommitHeadSha: "after",
				expectedPostConflictHeadSha: null,
				usedConflictResolution: false,
				finalizationSummaryMarkdown: null,
				finalizedHeadSha: null,
			},
		});

		expect(state.finalization).not.toHaveProperty("expectedPreCommitHeadSha");
		expect(state.finalization).not.toHaveProperty("expectedPostCommitHeadSha");
	});
});
