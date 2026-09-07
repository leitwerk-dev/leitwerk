import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ParsedTransferLink } from "@leitwerk-dev/session-transfer";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTransferState } from "./local-state.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
	const value = await mkdtemp(path.join(os.tmpdir(), "leitwerk-local-transfer-"));
	roots.push(value);
	return value;
}

const link: ParsedTransferLink = {
	origin: "https://leitwerk.example",
	instanceId: "agt_1",
	grantId: "trg_1",
	token: "this-is-a-secret-bearer-token-value",
	grantUrl: "https://leitwerk.example/api/session-transfers/agt_1/trg_1",
};

async function ageRecord(agent: string): Promise<void> {
	const root = path.join(agent, "leitwerk-session-transfer", "transfers");
	const [name] = await readdir(root);
	if (!name) throw new Error("Expected transfer state record");
	const file = path.join(root, name);
	const record = JSON.parse(await readFile(file, "utf8"));
	record.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	await writeFile(file, JSON.stringify(record));
}

describe("local transfer state", () => {
	it("preserves an unresolved commit record when the link is retried", async () => {
		const agent = await root();
		const state = new LocalTransferState(agent);
		await state.begin(link, {
			attemptId: "original",
			temporaryDirectory: path.join(agent, "original"),
			ownerId: "original-owner",
		});
		await state.recordCommitTargets(link, {
			destination: path.join(agent, "destination"),
			sessionPath: path.join(agent, "session.jsonl"),
		});
		const recordsRoot = path.join(agent, "leitwerk-session-transfer", "transfers");
		const [recordName] = await readdir(recordsRoot);
		if (!recordName) throw new Error("Expected recovery record");
		const recordFile = path.join(recordsRoot, recordName);
		const before = await readFile(recordFile, "utf8");
		await expect(
			state.begin(link, {
				attemptId: "retry",
				temporaryDirectory: path.join(agent, "retry"),
				ownerId: "retry-owner",
			}),
		).rejects.toThrow("still has recovery state");
		expect(await readFile(recordFile, "utf8")).toBe(before);
		expect(await readdir(recordsRoot)).toEqual([recordName]);
	});

	it.skipIf(process.getuid?.() === 0)(
		"retains recovery state and the ownership marker when cleanup fails",
		async () => {
			const agent = await root();
			const state = new LocalTransferState(agent);
			const temporaryDirectory = path.join(agent, "temporary");
			const protectedDirectory = path.join(temporaryDirectory, "read-only");
			await mkdir(protectedDirectory, { recursive: true });
			await writeFile(path.join(temporaryDirectory, state.markerName()), "owner\n");
			await writeFile(path.join(protectedDirectory, "retained.txt"), "retained");
			await state.begin(link, { attemptId: "tra_1", temporaryDirectory, ownerId: "owner" });
			await chmod(protectedDirectory, 0o555);
			try {
				await expect(state.discard(link)).rejects.toThrow();
				expect(await readFile(path.join(temporaryDirectory, state.markerName()), "utf8")).toBe(
					"owner\n",
				);
				expect(
					await readdir(path.join(agent, "leitwerk-session-transfer", "transfers")),
				).toHaveLength(1);
			} finally {
				await chmod(protectedDirectory, 0o700);
			}
			await state.discard(link);
			await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readdir(path.join(agent, "leitwerk-session-transfer", "transfers"))).toEqual([]);
		},
	);

	it("preserves temporary paths without its matching ownership marker", async () => {
		const agent = await root();
		const state = new LocalTransferState(agent);
		const temporaryDirectory = path.join(agent, "unowned");
		await mkdir(temporaryDirectory);
		await writeFile(path.join(temporaryDirectory, state.markerName()), "another-owner\n");
		await writeFile(path.join(temporaryDirectory, "existing.txt"), "existing work");
		await state.begin(link, { attemptId: "tra_1", temporaryDirectory, ownerId: "owner" });
		await state.discard(link);
		expect(await readFile(path.join(temporaryDirectory, "existing.txt"), "utf8")).toBe(
			"existing work",
		);
	});

	it("atomically promotes recovery state into a token-free completion receipt", async () => {
		const agent = await root();
		const state = new LocalTransferState(agent);
		await state.begin(link, {
			attemptId: "tra_1",
			temporaryDirectory: "/tmp/importing",
			ownerId: "owner-1",
		});
		expect(await state.receipt(link)).toBeNull();
		await state.complete(link, {
			destination: "/tmp/project",
			sessionPath: "/tmp/session.jsonl",
			completedAt: new Date().toISOString(),
		});
		const receipt = await state.receipt(link);
		expect(receipt?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(receipt)).not.toContain(link.token);
	});

	it("preserves completed destinations and sessions while cleaning commit metadata", async () => {
		const agent = await root();
		const state = new LocalTransferState(agent);
		const temporary = path.join(agent, "temporary-complete");
		const destination = path.join(agent, "destination-complete");
		const sessionPath = path.join(agent, "sessions", "complete.jsonl");
		const markerName = state.markerName("owner-complete");
		await mkdir(temporary, { recursive: true });
		await mkdir(destination, { recursive: true });
		await mkdir(path.dirname(sessionPath), { recursive: true });
		await writeFile(path.join(temporary, state.markerName()), "owner-complete\n");
		await writeFile(path.join(destination, markerName), "owner-complete\n");
		await writeFile(path.join(destination, "work.txt"), "work\n");
		await writeFile(sessionPath, "session\n");
		await state.begin(link, {
			attemptId: "tra_1",
			temporaryDirectory: temporary,
			ownerId: "owner-complete",
		});
		await state.recordCommitTargets(link, { destination, sessionPath });
		await state.complete(link, { destination, sessionPath, completedAt: new Date().toISOString() });
		await state.reconcile();

		expect(await readFile(path.join(destination, "work.txt"), "utf8")).toBe("work\n");
		expect(await readFile(sessionPath, "utf8")).toBe("session\n");
		await expect(stat(path.join(destination, markerName))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await state.receipt(link)).toMatchObject({ destination, sessionPath });
	});

	it("removes only stale incomplete targets carrying its ownership marker", async () => {
		const agent = await root();
		const state = new LocalTransferState(agent);
		const temporary = path.join(agent, "temporary");
		const destination = path.join(agent, "destination");
		const sessionPath = path.join(agent, "sessions", "import.jsonl");
		await mkdir(temporary, { recursive: true });
		await mkdir(destination, { recursive: true });
		await mkdir(path.dirname(sessionPath), { recursive: true });
		await writeFile(path.join(temporary, state.markerName()), "owner-1\n");
		await writeFile(path.join(destination, state.markerName("owner-1")), "owner-1\n");
		await writeFile(sessionPath, "session\n");
		await state.begin(link, {
			attemptId: "tra_1",
			temporaryDirectory: temporary,
			ownerId: "owner-1",
		});
		await state.recordCommitTargets(link, { destination, sessionPath });
		await ageRecord(agent);
		await state.reconcile();

		await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
