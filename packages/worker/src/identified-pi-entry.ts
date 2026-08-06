import type { PiTreeHandle } from "./pi-adapter.js";

export type LeitwerkPromptIdentity =
	| { kind: "turn_prompt"; startRecordId: string; purpose: "kickoff" | "continue" }
	| { kind: "process_input"; processInputId: string };

export type LeitwerkCompactionIdentity = { kind: "turn_compaction"; startRecordId: string };
export type LeitwerkEntryIdentity = LeitwerkPromptIdentity | LeitwerkCompactionIdentity;

function isOnCurrentBranch(piHandle: PiTreeHandle, entryId: string): boolean {
	return piHandle
		.getBranch(piHandle.getLeafId() ?? undefined)
		.some((entry) => entry.id === entryId);
}

function matchesParent(input: {
	piHandle: PiTreeHandle;
	parentId: string | null;
	expectedParentId: string | null;
	allowDescendantParent?: boolean;
}): boolean {
	if (input.parentId === input.expectedParentId) return true;
	if (!input.allowDescendantParent || input.parentId === null) return false;
	if (input.expectedParentId === null) return isOnCurrentBranch(input.piHandle, input.parentId);
	return input.piHandle
		.getBranch(input.parentId)
		.some((entry) => entry.id === input.expectedParentId);
}

function sameIdentity(left: unknown, right: LeitwerkEntryIdentity): boolean {
	if (!left || typeof left !== "object") return false;
	const value = left as Record<string, unknown>;
	if (value.kind !== right.kind) return false;
	if (right.kind === "process_input") return value.processInputId === right.processInputId;
	if (right.kind === "turn_compaction") return value.startRecordId === right.startRecordId;
	return value.startRecordId === right.startRecordId && value.purpose === right.purpose;
}

function matchingEntries(handle: PiTreeHandle, identity: LeitwerkEntryIdentity) {
	const entries: ReturnType<PiTreeHandle["getTree"]>[number]["entry"][] = [];
	type TreeNode = ReturnType<PiTreeHandle["getTree"]>[number];
	const visit = (nodes: readonly TreeNode[]) => {
		for (const node of nodes) {
			const isMatchingPrompt =
				node.entry.type === "custom_message" && node.entry.customType === "leitwerk";
			const isMatchingCompaction = node.entry.type === "compaction";
			if (
				(isMatchingPrompt || isMatchingCompaction) &&
				sameIdentity(node.entry.details, identity)
			) {
				entries.push(node.entry);
			}
			visit(node.children);
		}
	};
	visit(handle.getTree());
	return entries;
}

/** Resolve one exact identified entry without changing the selected Pi branch. */
export function findIdentifiedPrompt(
	piHandle: PiTreeHandle,
	identity: LeitwerkEntryIdentity,
): ReturnType<typeof matchingEntries>[number] | null {
	const matches = matchingEntries(piHandle, identity);
	if (matches.length > 1) {
		throw new Error(`Pi tree has duplicate Leitwerk prompt identity '${JSON.stringify(identity)}'`);
	}
	return matches[0] ?? null;
}

interface IdentifiedPromptExpectation {
	piHandle: PiTreeHandle;
	identity: LeitwerkEntryIdentity;
	content: string;
	expectedParentId: string | null;
	allowDescendantParent?: boolean;
	requireOnCurrentBranch?: boolean;
}

function assertIdentifiedPrompt(
	match: ReturnType<typeof findIdentifiedPrompt>,
	input: IdentifiedPromptExpectation,
): void {
	if (
		match?.type === "custom_message" &&
		match.customType === "leitwerk" &&
		match.content === input.content &&
		matchesParent({
			piHandle: input.piHandle,
			parentId: match.parentId,
			expectedParentId: input.expectedParentId,
			allowDescendantParent: input.allowDescendantParent,
		}) &&
		(!input.requireOnCurrentBranch || isOnCurrentBranch(input.piHandle, match.id))
	) {
		return;
	}
	throw new Error(`Pi tree has mismatched Leitwerk prompt '${JSON.stringify(input.identity)}'`);
}

/** Validate immutable content for an already identified entry without moving the leaf. */
export function validateIdentifiedPrompt(input: IdentifiedPromptExpectation): void {
	assertIdentifiedPrompt(findIdentifiedPrompt(input.piHandle, input.identity), input);
}

/** Reuse an exact identified compaction, or perform one at the selected branch leaf. */
export async function ensureIdentifiedCompaction(input: {
	piHandle: PiTreeHandle;
	identity: LeitwerkCompactionIdentity;
	expectedParentId: string | null;
	/** `current_leaf` receipts permit post-acceptance inputs on the same branch. */
	allowDescendantParent?: boolean;
	/** Reject a retained identity on a sibling branch. */
	requireOnCurrentBranch?: boolean;
	/** A running-turn replacement validates retained context without rewinding its current leaf. */
	reuseWithoutBranching?: boolean;
	/** Acknowledgement-loss recovery never appends behind an already active turn. */
	requireExisting?: boolean;
}): Promise<string> {
	const match = findIdentifiedPrompt(input.piHandle, input.identity);
	if (match) {
		if (
			match.type !== "compaction" ||
			!matchesParent({
				piHandle: input.piHandle,
				parentId: match.parentId,
				expectedParentId: input.expectedParentId,
				allowDescendantParent: input.allowDescendantParent,
			}) ||
			(input.requireOnCurrentBranch && !isOnCurrentBranch(input.piHandle, match.id))
		) {
			throw new Error(
				`Pi tree has mismatched Leitwerk compaction '${JSON.stringify(input.identity)}'`,
			);
		}
		if (!input.reuseWithoutBranching) await input.piHandle.branch(match.id);
		return match.id;
	}
	if (!input.piHandle.compact) throw new Error("Pi handle does not support compaction");
	if (input.piHandle.getLeafId() !== input.expectedParentId) {
		throw new Error("Pi tree changed before the identified compaction could be appended");
	}
	await input.piHandle.compact(undefined, input.identity);
	const appended = findIdentifiedPrompt(input.piHandle, input.identity);
	if (!appended || appended.type !== "compaction" || appended.parentId !== input.expectedParentId) {
		throw new Error(
			`Pi tree has mismatched Leitwerk compaction '${JSON.stringify(input.identity)}'`,
		);
	}
	return appended.id;
}

/** Reuse one exact identified entry, or append it at the selected branch leaf. */
export async function ensureIdentifiedPrompt(input: {
	piHandle: PiTreeHandle;
	identity: LeitwerkPromptIdentity;
	content: string;
	expectedParentId: string | null;
	allowDescendantParent?: boolean;
	requireOnCurrentBranch?: boolean;
	/** Recovery may validate an ancestor prompt without rewinding an advanced current leaf. */
	reuseWithoutBranching?: boolean;
	/** Recovery with a later retained kickoff must not append a missing earlier prompt. */
	requireExisting?: boolean;
}): Promise<string> {
	const match = findIdentifiedPrompt(input.piHandle, input.identity);
	if (match) {
		assertIdentifiedPrompt(match, input);
		if (!input.reuseWithoutBranching) await input.piHandle.branch(match.id);
		return match.id;
	}
	if (!input.piHandle.appendCustomMessage) {
		throw new Error("Pi handle does not support identified custom messages");
	}
	if (input.requireExisting) {
		throw new Error(
			`Pi tree is missing retained Leitwerk prompt '${JSON.stringify(input.identity)}'`,
		);
	}
	if (input.piHandle.getLeafId() !== input.expectedParentId) {
		throw new Error("Pi tree changed before the identified prompt could be appended");
	}
	return await input.piHandle.appendCustomMessage({
		content: input.content,
		details: input.identity,
	});
}
