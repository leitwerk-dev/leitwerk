import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ParsedTransferLink } from "@leitwerk-dev/session-transfer";
import { afterEach, expect, it } from "vitest";
import { LocalTransferState } from "./local-state.js";
import {
	populateWorkspaceDestination,
	reserveWorkspaceDestination,
	restoreWorkspaceMetadata,
} from "./workspace-commit.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-workspace-commit-"));
	roots.push(root);
	const source = path.join(root, "staging", "workspace");
	await mkdir(source, { recursive: true });
	const destination = path.join(root, "destination");
	const marker = { name: ".leitwerk-transfer-owner-owner-1", ownerId: "owner-1" };
	return { root, source, destination, marker };
}

it("preserves an independently created empty destination at the exclusive claim", async () => {
	const { destination, marker } = await fixture();
	await mkdir(destination, { mode: 0o750 });
	const before = await stat(destination);
	await expect(reserveWorkspaceDestination(destination, marker)).rejects.toMatchObject({
		code: "EEXIST",
	});
	const after = await stat(destination);
	expect(after.ino).toBe(before.ino);
	expect(after.mode).toBe(before.mode);
	expect(after.mtimeMs).toBe(before.mtimeMs);
	expect(await readdir(destination)).toEqual([]);
});

it.each([
	0o750, 0o555,
])("moves workspace entries and restores directory mode %i after removing the marker", async (mode) => {
	const { source, destination, marker } = await fixture();
	await mkdir(path.join(source, "repo"));
	await writeFile(path.join(source, "repo", "run"), "content", { mode: 0o755 });
	await symlink("repo/run", path.join(source, "link"));
	await chmod(source, mode);
	await utimes(source, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
	const before = await stat(source);
	await reserveWorkspaceDestination(destination, marker);
	const metadata = await populateWorkspaceDestination(source, destination);
	expect(await readFile(path.join(destination, "repo", "run"), "utf8")).toBe("content");
	expect((await stat(path.join(destination, "repo", "run"))).mode & 0o777).toBe(0o755);
	expect(await readlink(path.join(destination, "link"))).toBe("repo/run");
	expect((await stat(destination)).mode & 0o777).toBe(0o700);
	expect(await readFile(path.join(destination, marker.name), "utf8")).toBe("owner-1\n");
	await rm(path.join(destination, marker.name));
	await restoreWorkspaceMetadata(destination, metadata);
	expect((await stat(destination)).mode).toBe(before.mode);
	expect((await stat(destination)).mtimeMs).toBe(before.mtimeMs);
	expect(await readdir(source)).toEqual([]);
	await chmod(source, 0o700);
	await chmod(destination, 0o700);
});

it("recovers both staged and moved files after an interrupted workspace population", async () => {
	const { root, source, destination, marker } = await fixture();
	const state = new LocalTransferState(root);
	const link: ParsedTransferLink = {
		origin: "https://leitwerk.example",
		instanceId: "agt_1",
		grantId: "trg_1",
		token: "transfer-test-token",
		grantUrl: "https://leitwerk.example/api/session-transfers/agt_1/trg_1",
	};
	const temporaryDirectory = path.dirname(source);
	await writeFile(path.join(temporaryDirectory, state.markerName()), `${marker.ownerId}\n`);
	await writeFile(path.join(source, "moved"), "first");
	await writeFile(path.join(source, "remaining"), "second");
	const sessionPath = path.join(root, "session.jsonl");
	await state.begin(link, { attemptId: "tra_1", temporaryDirectory, ownerId: marker.ownerId });
	await state.recordCommitTargets(link, { destination, sessionPath });
	await reserveWorkspaceDestination(destination, marker);
	await rename(path.join(source, "moved"), path.join(destination, "moved"));
	const recordsRoot = path.join(root, "leitwerk-session-transfer", "transfers");
	const [recordName] = await readdir(recordsRoot);
	if (!recordName) throw new Error("Expected recovery record");
	const recordFile = path.join(recordsRoot, recordName);
	const record = JSON.parse(await readFile(recordFile, "utf8"));
	record.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	await writeFile(recordFile, JSON.stringify(record));
	await state.reconcile();
	await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await state.receipt(link)).toBeNull();
});
