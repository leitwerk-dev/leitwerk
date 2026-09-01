import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
