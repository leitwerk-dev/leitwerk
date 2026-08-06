import { describe, expect, it } from "vitest";
import { createReadonlyEntryTree } from "./session-entry-tree.js";
import {
	buildTurnContinuationSlice,
	type ContinuationTreeEntry,
	extractFirstUserPromptOnBranch,
	hasTurnContinuationProgress,
	resolveTurnContinuationLeafEntryId,
	resolveTurnContinuationUserPrompt,
} from "./turn-continuation.js";

function messageEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
	message?: { role?: string; content?: unknown },
): ContinuationTreeEntry {
	return {
		id,
		parentId,
		timestamp,
		type: "message",
		...(message ? { message } : {}),
	};
}

function labelEntry(id: string, parentId: string | null, timestamp: string): ContinuationTreeEntry {
	return {
		id,
		parentId,
		timestamp,
		type: "label",
	};
}

function compactionEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
): ContinuationTreeEntry {
	return {
		id,
		parentId,
		timestamp,
		type: "compaction",
	};
}

describe("turn continuation helpers", () => {
	it("prefers the explicit result leaf when it belongs to the turn branch", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("assistant-a", "root", "2026-04-26T10:00:01.000Z"),
			messageEntry("assistant-b", "assistant-a", "2026-04-26T10:00:02.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "assistant-b",
				startedAt: "2026-04-26T10:00:00.500Z",
				status: "failed",
			}),
		).toBe("assistant-b");
	});

	it("prefers the latest saved descendant of the explicit result leaf when more progress was saved", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("assistant-partial", "root", "2026-04-26T10:00:05.000Z"),
			messageEntry("assistant-final", "assistant-partial", "2026-04-26T10:00:07.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "assistant-partial",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("assistant-final");
	});

	it("continues failed turns from an explicit compaction result leaf", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("assistant-overflow", "root", "2026-04-26T10:00:05.000Z"),
			compactionEntry("compact-1", "assistant-overflow", "2026-04-26T10:00:06.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "compact-1",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("compact-1");
		expect(
			buildTurnContinuationSlice(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "compact-1",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}).map((entry) => entry.id),
		).toEqual(["assistant-overflow", "compact-1"]);
	});

	it("can bound failed result extension at the turn end for historical attribution", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("assistant-partial", "root", "2026-04-26T10:00:05.000Z"),
			messageEntry("assistant-next-attempt", "assistant-partial", "2026-04-26T10:00:07.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(
				entries,
				{
					forkPiEntryId: "root",
					resultPiEntryId: "assistant-partial",
					startedAt: "2026-04-26T10:00:04.000Z",
					status: "failed",
				},
				{ endedAt: "2026-04-26T10:00:06.000Z" },
			),
		).toBe("assistant-partial");
	});

	it("keeps succeeded turns anchored at their explicit result leaf", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("assistant-partial", "root", "2026-04-26T10:00:05.000Z"),
			messageEntry("assistant-next-turn", "assistant-partial", "2026-04-26T10:00:07.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "assistant-partial",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "succeeded",
			}),
		).toBe("assistant-partial");
	});

	it("falls back to the latest saved descendant when the failed turn never recorded a result leaf", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("older-attempt", "root", "2026-04-26T10:00:01.000Z"),
			messageEntry("continued-tool", "root", "2026-04-26T10:00:05.000Z"),
			messageEntry("continued-assistant", "continued-tool", "2026-04-26T10:00:06.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: null,
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("continued-assistant");
		expect(
			hasTurnContinuationProgress(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: null,
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe(true);
	});

	it("keeps the latest failed user continuation leaf instead of rewinding to its assistant parent", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z", {
				role: "assistant",
				content: "Seeded branch",
			}),
			messageEntry("assistant-timeout", "root", "2026-04-26T10:00:05.000Z", {
				role: "assistant",
				content: "Timed out leaf",
			}),
			messageEntry("user-continue", "assistant-timeout", "2026-04-26T10:00:06.000Z", {
				role: "user",
				content: "continue",
			}),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "user-continue",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("user-continue");
		expect(
			resolveTurnContinuationUserPrompt(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "user-continue",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("continue");
	});

	it("ignores saved descendants from earlier attempts on the same fork", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("attempt-1", "root", "2026-04-26T10:00:01.000Z"),
			messageEntry("attempt-2", "root", "2026-04-26T10:00:05.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: null,
				startedAt: "2026-04-26T10:00:04.500Z",
				status: "failed",
			}),
		).toBe("attempt-2");
	});

	it("uses endedAt bounds so later continuation branches do not replace the failed compaction leaf", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("assistant-overflow", "root", "2026-04-26T10:00:05.000Z"),
			compactionEntry("compact-1", "assistant-overflow", "2026-04-26T10:00:06.000Z"),
			messageEntry("later-user", "compact-1", "2026-04-26T10:00:08.000Z", {
				role: "user",
				content: "continue after retry",
			}),
		];

		expect(
			resolveTurnContinuationLeafEntryId(
				entries,
				{
					forkPiEntryId: "root",
					resultPiEntryId: "compact-1",
					startedAt: "2026-04-26T10:00:04.000Z",
					status: "failed",
				},
				{ endedAt: "2026-04-26T10:00:07.000Z" },
			),
		).toBe("compact-1");
		expect(
			resolveTurnContinuationUserPrompt(
				entries,
				{
					forkPiEntryId: "root",
					resultPiEntryId: "compact-1",
					startedAt: "2026-04-26T10:00:04.000Z",
					status: "failed",
				},
				{ endedAt: "2026-04-26T10:00:07.000Z" },
			),
		).toBeNull();
	});

	it("does not treat non-message entries as continuable progress", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			labelEntry("label-1", "root", "2026-04-26T10:00:05.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: null,
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBeNull();
		expect(
			hasTurnContinuationProgress(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: null,
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe(false);
	});

	it("ignores explicit result leaves that predate the current attempt and uses newer saved progress instead", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("stale-result", "root", "2026-04-26T10:00:01.000Z"),
			messageEntry("current-result", "root", "2026-04-26T10:00:05.000Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "stale-result",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("current-result");
	});

	it("preserves operator-added continuation instructions from the latest failed user leaf", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z", {
				role: "assistant",
				content: "Seeded branch",
			}),
			messageEntry("assistant-timeout", "root", "2026-04-26T10:00:05.000Z", {
				role: "assistant",
				content: "Timed out leaf",
			}),
			messageEntry("user-follow-up", "assistant-timeout", "2026-04-26T10:00:06.000Z", {
				role: "user",
				content: "Continue from this exact branch and keep the previous tool choice.",
			}),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "user-follow-up",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("user-follow-up");
		expect(
			resolveTurnContinuationUserPrompt(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "user-follow-up",
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}),
		).toBe("Continue from this exact branch and keep the previous tool choice.");
	});

	it("keeps progress whose timestamp matches the turn start even when ISO formatting differs", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("current-result", "root", "2026-04-26T10:00:05Z"),
		];

		expect(
			resolveTurnContinuationLeafEntryId(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "current-result",
				startedAt: "2026-04-26T10:00:05.000Z",
				status: "failed",
			}),
		).toBe("current-result");
		expect(
			hasTurnContinuationProgress(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: "current-result",
				startedAt: "2026-04-26T10:00:05.000Z",
				status: "failed",
			}),
		).toBe(true);
	});

	it("builds the continuation slice after the fork and within the current attempt window", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("previous-attempt", "root", "2026-04-26T10:00:01.000Z"),
			messageEntry("current-assistant", "root", "2026-04-26T10:00:05.000Z"),
			messageEntry("current-user", "current-assistant", "2026-04-26T10:00:06.000Z"),
		];

		expect(
			buildTurnContinuationSlice(entries, {
				forkPiEntryId: "root",
				resultPiEntryId: null,
				startedAt: "2026-04-26T10:00:04.000Z",
				status: "failed",
			}).map((entry) => entry.id),
		).toEqual(["current-assistant", "current-user"]);
	});

	it("uses the latest branch entry before an end bound when no result leaf was recorded", () => {
		const entries = [
			messageEntry("root", null, "2026-04-26T10:00:00.000Z"),
			messageEntry("failed-progress", "root", "2026-04-26T10:00:05.000Z"),
			messageEntry("retry-progress", "root", "2026-04-26T10:00:09.000Z"),
		];

		expect(
			buildTurnContinuationSlice(
				entries,
				{
					forkPiEntryId: "root",
					resultPiEntryId: null,
					startedAt: "2026-04-26T10:00:04.000Z",
					status: "failed",
				},
				{ endedAt: "2026-04-26T10:00:06.000Z" },
			).map((entry) => entry.id),
		).toEqual(["failed-progress"]);
	});

	it("extracts the first non-empty user prompt on the selected branch", () => {
		const entries = [
			messageEntry("empty-user", null, "2026-04-26T10:00:00.000Z", {
				role: "user",
				content: "   ",
			}),
			messageEntry("ignored-sibling-user", "empty-user", "2026-04-26T10:00:01.000Z", {
				role: "user",
				content: "sibling prompt",
			}),
			messageEntry("assistant", "empty-user", "2026-04-26T10:00:02.000Z", {
				role: "assistant",
				content: "assistant output",
			}),
			messageEntry("prompt-user", "assistant", "2026-04-26T10:00:03.000Z", {
				role: "user",
				content: [{ type: "text", text: "branch prompt" }],
			}),
			messageEntry("leaf", "prompt-user", "2026-04-26T10:00:04.000Z", {
				role: "assistant",
				content: "done",
			}),
		];

		expect(extractFirstUserPromptOnBranch(createReadonlyEntryTree(entries), "leaf")).toEqual({
			text: "branch prompt",
			createdAt: "2026-04-26T10:00:03.000Z",
		});
	});
});
