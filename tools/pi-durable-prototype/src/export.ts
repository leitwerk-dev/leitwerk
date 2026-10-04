// biome-ignore-all lint/style/noNonNullAssertion: This throwaway fixture requires identities established by preceding operations and assertions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
	DEFAULT_SESSION_TRANSFER_LIMITS,
	extractTransferArchive,
	prepareTransferArchive,
	rewritePiSession,
} from "@leitwerk-dev/session-transfer";
import type { PrototypeRuntime } from "./runtime.ts";

type History = Awaited<ReturnType<PrototypeRuntime["history"]>>;
/** V3 compatibility projection, not a substitute for Pi Durable's native store. @internal */
export function piSession(history: History, instanceId: string): string {
	const entries = new Map<number, EntryRecord>();
	const parents = new Map(history.conversations.map((c) => [c.id, c.parent]));
	for (const conversation of history.conversations)
		for (const e of conversation.entries) entries.set(e.id, e);
	const tails = new Map<number, string>();
	const timestamp = new Date().toISOString();
	const output: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: instanceId, timestamp, cwd: "/workspace/repo" },
	];
	for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) {
		// Context edits/compaction require semantic conversion, not just a new header.
		if (entry.head !== undefined || entry.edits?.length)
			throw new Error("Prototype export does not support reset, compaction, or context edits");
		let parentId =
			tails.get(entry.conversationId) ??
			(parents.get(entry.conversationId) ? `d${parents.get(entry.conversationId)!.at}` : null);
		const messages = entry.model?.length ? entry.model : [null];
		for (const [index, message] of messages.entries()) {
			const id = index === messages.length - 1 ? `d${entry.id}` : `d${entry.id}m${index}`;
			const body =
				message && message.role !== "system"
					? {
							type: "message",
							message: {
								...message,
								timestamp: "timestamp" in message ? message.timestamp : Date.parse(timestamp),
							},
						}
					: {
							type: "custom",
							customType: `pi_durable.${entry.kind}`,
							data: { message, data: entry.data ?? null },
						};
			output.push({ id, parentId, timestamp, ...body });
			parentId = id;
		}
		tails.set(entry.conversationId, parentId!);
	}
	if (history.index?.primaryLeaf)
		output.push({
			type: "custom",
			customType: "leitwerk.primary_selection",
			id: "primary-selection",
			parentId: `d${history.index.primaryLeaf}`,
			timestamp,
			data: {},
		});
	return `${output.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** Exercise the application's archive and Pi reader against the converted tree. @internal */
export async function evaluateExport(
	history: History,
	workspace: string,
	serverDirectory: string,
	instanceId: string,
) {
	const sessionFile = path.join(serverDirectory, "projection.jsonl");
	writeFileSync(sessionFile, piSession(history, instanceId));
	const prepared = await prepareTransferArchive({
		workspaceRoot: workspace,
		sessionFile,
		limits: DEFAULT_SESSION_TRANSFER_LIMITS,
		manifest: {
			version: 1,
			instanceId,
			createdAt: new Date().toISOString(),
			session: { sourceCwd: "/workspace/repo", cwdRelativeToWorkspace: "repo" },
			projects: [{ key: "repo", relativePath: "repo", branch: null, head: null }],
		},
	});
	const outputRoot = path.join(serverDirectory, "local-export");
	const extracted = await extractTransferArchive({ compressed: prepared.stream({}), outputRoot });
	const localRepo = path.join(outputRoot, "workspace/repo");
	const rewritten = rewritePiSession(
		readFileSync(path.join(outputRoot, "session.jsonl"), "utf8"),
		localRepo,
		"/workspace/repo",
	);
	const localSession = path.join(outputRoot, "local.jsonl");
	writeFileSync(localSession, rewritten.content);
	const manager = SessionManager.open(localSession);
	const branch = JSON.stringify(manager.getBranch());
	assert(branch.includes("Revised plan"));
	assert(!branch.includes("Reviewed plan"));
	assert(JSON.stringify(manager.getEntries()).includes("Reviewed plan"));
	for (const receipt of Object.values(history.index!.receipts)) {
		const payload = JSON.parse(receipt.payload);
		assert(manager.getEntry(payload.resultPiEntryId), "Product reference was lost in export");
	}
	assert.equal(readFileSync(path.join(localRepo, "draft.md"), "utf8"), "Revised plan\n");
	const status = execFileSync("git", ["status", "--porcelain"], {
		cwd: localRepo,
		encoding: "utf8",
	});
	assert(status.includes("draft.md"));
	assert.equal(
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: localRepo,
			encoding: "utf8",
		}).trim(),
		"true",
	);
	return {
		entries: rewritten.entryCount,
		archiveBytes: extracted.compressedBytes,
		productsResolved: Object.keys(history.index!.receipts).length,
		uncommittedWorkspacePreserved: true,
	};
}
