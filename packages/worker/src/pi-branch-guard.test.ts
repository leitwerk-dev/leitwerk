import type { PiTreeEntry } from "@leitwerk-dev/process-sdk";
import { createReadonlyEntryTree } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import {
	assertResultStayedOnExecutionBranch,
	PiBranchDriftError,
	resolveExecutionAnchorEntryId,
} from "./pi-branch-guard.js";

const entry = (id: string, parentId: string | null, role = "assistant"): PiTreeEntry => ({
	id,
	parentId,
	type: "message",
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role, content: id },
});

describe("pi branch guard", () => {
	it("anchors prompts to the created user entry after setup entries", () => {
		expect(
			resolveExecutionAnchorEntryId({
				operation: "prompt",
				startLeafId: "selected",
				createdEntries: [entry("setup", "selected"), entry("user-prompt", "setup", "user")],
			}),
		).toBe("user-prompt");
	});

	it.each([
		{
			name: "accepts descendants of the prompt anchor",
			entries: [
				entry("selected", null),
				entry("user-prompt", "selected", "user"),
				entry("result", "user-prompt"),
			],
			input: { startLeafId: "selected", anchorEntryId: "user-prompt", resultEntryId: "result" },
			throws: false,
		},
		{
			name: "rejects sibling branches",
			entries: [
				entry("selected", null),
				entry("user-prompt", "selected", "user"),
				entry("sibling-result", "selected"),
			],
			input: {
				startLeafId: "selected",
				anchorEntryId: "user-prompt",
				resultEntryId: "sibling-result",
			},
			throws: true,
		},
		{
			name: "rejects root-start prompts under existing entries",
			entries: [entry("old-root", null), entry("new-user", "old-root", "user")],
			input: { startLeafId: null, anchorEntryId: "new-user", resultEntryId: "new-user" },
			throws: true,
		},
	])("$name", ({ entries, input, throws }) => {
		const assert = () =>
			assertResultStayedOnExecutionBranch({
				operation: "prompt",
				beforeEntryIds: new Set(["selected", "old-root"]),
				getBranch: createReadonlyEntryTree(entries).getBranch,
				...input,
			});

		if (throws) {
			expect(assert).toThrow(PiBranchDriftError);
		} else {
			expect(assert).not.toThrow();
		}
	});
});
