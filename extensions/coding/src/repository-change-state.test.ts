import { describe, expect, it } from "vitest";
import { repositoryChangeStateCodec } from "./repository-change-state.js";

describe("repositoryChangeStateCodec", () => {
	it("keeps the generated commit message and drops retired finalization fields", () => {
		const state = repositoryChangeStateCodec.parse({
			finalization: {
				generatedCommitMessage: "feat: publish change",
				expectedPostConflictHeadSha: "obsolete",
				usedConflictResolution: true,
				finalizedHeadSha: "obsolete",
			},
		});

		expect(state.finalization).toEqual({ generatedCommitMessage: "feat: publish change" });
	});
});
