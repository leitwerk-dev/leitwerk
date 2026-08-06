import { StubPiTreeHandle } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it } from "vitest";
import {
	ensureIdentifiedCompaction,
	ensureIdentifiedPrompt,
	validateIdentifiedPrompt,
} from "./identified-pi-entry.js";

describe("ensureIdentifiedPrompt", () => {
	it("reuses an exact identified prompt and retains its entry id", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-prompt" });
		const identity = {
			kind: "turn_prompt" as const,
			startRecordId: "start-1",
			purpose: "kickoff" as const,
		};
		const entryId = await ensureIdentifiedPrompt({
			piHandle,
			identity,
			content: "Implement the task.",
			expectedParentId: null,
		});
		await piHandle.branchFromRoot();
		expect(
			await ensureIdentifiedPrompt({
				piHandle,
				identity,
				content: "Implement the task.",
				expectedParentId: null,
			}),
		).toBe(entryId);
		expect(piHandle.getTree()).toHaveLength(1);
	});

	it("rejects an identity whose existing content differs", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-prompt-mismatch" });
		const identity = { kind: "process_input" as const, processInputId: "input-1" };
		await ensureIdentifiedPrompt({
			piHandle,
			identity,
			content: "original",
			expectedParentId: null,
		});
		await piHandle.branchFromRoot();
		await expect(
			ensureIdentifiedPrompt({ piHandle, identity, content: "changed", expectedParentId: null }),
		).rejects.toThrow("mismatched Leitwerk prompt");
	});

	it("rejects a prompt replayed from a different parent", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-prompt-parent" });
		const identity = { kind: "process_input" as const, processInputId: "input-parent" };
		await piHandle.prompt("seed");
		await ensureIdentifiedPrompt({
			piHandle,
			identity,
			content: "follow up",
			expectedParentId: piHandle.getLeafId(),
		});
		await expect(
			ensureIdentifiedPrompt({
				piHandle,
				identity,
				content: "follow up",
				expectedParentId: null,
			}),
		).rejects.toThrow("mismatched Leitwerk prompt");
		await expect(() =>
			validateIdentifiedPrompt({
				piHandle,
				identity,
				content: "follow up",
				expectedParentId: null,
			}),
		).toThrow("mismatched Leitwerk prompt");
	});

	it("reuses one identified compaction with its stable entry id", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-compaction" });
		await piHandle.prompt("seed");
		const parentId = piHandle.getLeafId();
		if (!parentId) throw new Error("expected seeded parent");
		const identity = { kind: "turn_compaction" as const, startRecordId: "start-compact" };
		const entryId = await ensureIdentifiedCompaction({
			piHandle,
			identity,
			expectedParentId: parentId,
		});
		await piHandle.branch(parentId);
		expect(
			await ensureIdentifiedCompaction({ piHandle, identity, expectedParentId: parentId }),
		).toBe(entryId);
		expect(piHandle.getEntry(entryId)).toMatchObject({
			type: "compaction",
			parentId,
			details: identity,
		});
	});

	it("fails safely when a compaction identity is duplicated", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-compaction-duplicate" });
		const identity = { kind: "turn_compaction" as const, startRecordId: "start-duplicate" };
		await ensureIdentifiedCompaction({ piHandle, identity, expectedParentId: null });
		await piHandle.branchFromRoot();
		await piHandle.compact(undefined, identity);
		await expect(
			ensureIdentifiedCompaction({ piHandle, identity, expectedParentId: null }),
		).rejects.toThrow("duplicate Leitwerk prompt identity");
	});

	it("rejects a retained compaction from a different branch parent", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-compaction-parent" });
		await piHandle.prompt("seed");
		const identity = { kind: "turn_compaction" as const, startRecordId: "start-parent" };
		await ensureIdentifiedCompaction({
			piHandle,
			identity,
			expectedParentId: piHandle.getLeafId(),
		});
		await expect(
			ensureIdentifiedCompaction({ piHandle, identity, expectedParentId: null }),
		).rejects.toThrow("mismatched Leitwerk compaction");
	});

	it("rejects a retained identity from a sibling branch", async () => {
		const piHandle = new StubPiTreeHandle({ treeFile: "identified-sibling" });
		const identity = { kind: "process_input" as const, processInputId: "input-sibling" };
		const retainedId = await ensureIdentifiedPrompt({
			piHandle,
			identity,
			content: "retained",
			expectedParentId: null,
		});
		await piHandle.branchFromRoot();
		await piHandle.appendUserMessage("other branch");
		await expect(
			ensureIdentifiedPrompt({
				piHandle,
				identity,
				content: "retained",
				expectedParentId: null,
				requireOnCurrentBranch: true,
				reuseWithoutBranching: true,
			}),
		).rejects.toThrow("mismatched Leitwerk prompt");
		expect(piHandle.getLeafId()).not.toBe(retainedId);
	});
});
