import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createFileBackedProcessSessionSnapshotStore,
	createFilesystemSessionReader,
	createFilesystemSessionSource,
	isSafeSessionInstanceId,
	ProcessSessionReader,
	type ProcessSessionSnapshotHandle,
	type ProcessSessionSource,
} from "./process-session-store.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-session-store-"));
	tempRoots.push(root);
	return root;
}

function jsonl(...entries: readonly Record<string, unknown>[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function writeInstanceTree(root: string, instanceId: string, content: string): Promise<void> {
	await writeFile(path.join(root, `${instanceId}.jsonl`), content, "utf8");
}

/** Source whose signature and content are driven by the test for cache assertions. */
function createControllableSource(): {
	source: ProcessSessionSource;
	set(instanceId: string, signature: string, content: string): void;
	clear(instanceId: string): void;
	loadCount(instanceId: string): number;
} {
	const state = new Map<string, { signature: string; content: string; loads: number }>();
	return {
		source: {
			async readSnapshotHandle(instanceId): Promise<ProcessSessionSnapshotHandle | null> {
				const entry = state.get(instanceId);
				if (!entry) {
					return null;
				}
				return {
					signature: entry.signature,
					async load() {
						entry.loads += 1;
						return entry.content;
					},
				};
			},
		},
		set(instanceId, signature, content) {
			const existing = state.get(instanceId);
			state.set(instanceId, { signature, content, loads: existing?.loads ?? 0 });
		},
		clear(instanceId) {
			state.delete(instanceId);
		},
		loadCount(instanceId) {
			return state.get(instanceId)?.loads ?? 0;
		},
	};
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("ProcessSessionReader caching", () => {
	it("reuses the parsed instance tree while the signature is unchanged", async () => {
		const controllable = createControllableSource();
		controllable.set(
			"agt_1",
			"sig-1",
			jsonl(
				{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
				},
			),
		);
		const reader = new ProcessSessionReader(controllable.source);

		const first = await reader.readInstanceTree("agt_1");
		const second = await reader.readInstanceTree("agt_1");

		expect(first).toBe(second);
		expect(controllable.loadCount("agt_1")).toBe(1);
	});

	it("re-parses the instance tree when the signature changes", async () => {
		const controllable = createControllableSource();
		controllable.set(
			"agt_1",
			"sig-1",
			jsonl(
				{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
				},
			),
		);
		const reader = new ProcessSessionReader(controllable.source);

		const first = await reader.readInstanceTree("agt_1");
		controllable.set(
			"agt_1",
			"sig-2",
			jsonl(
				{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
				{
					type: "message",
					id: "entry-2",
					parentId: null,
					timestamp: "2026-01-01T00:00:02.000Z",
				},
			),
		);
		const second = await reader.readInstanceTree("agt_1");

		expect([...first.entriesById.keys()]).toEqual(["entry-1"]);
		expect([...second.entriesById.keys()]).toEqual(["entry-2"]);
		expect(controllable.loadCount("agt_1")).toBe(2);
	});

	it("returns an empty tree and drops the cache when the session disappears", async () => {
		const controllable = createControllableSource();
		controllable.set(
			"agt_1",
			"sig-1",
			jsonl({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
			}),
		);
		const reader = new ProcessSessionReader(controllable.source);

		await reader.readInstanceTree("agt_1");
		controllable.clear("agt_1");
		const afterRemoval = await reader.readInstanceTree("agt_1");

		expect(afterRemoval.entriesById.size).toBe(0);
	});

	it("deduplicates concurrent parses for the same signature", async () => {
		let releaseLoad: (() => void) | null = null;
		let loads = 0;
		const source: ProcessSessionSource = {
			async readSnapshotHandle(): Promise<ProcessSessionSnapshotHandle> {
				return {
					signature: "sig-1",
					async load() {
						loads += 1;
						await new Promise<void>((resolve) => {
							releaseLoad = resolve;
						});
						return jsonl(
							{
								type: "session",
								version: 3,
								id: "sess_1",
								timestamp: "2026-01-01T00:00:00.000Z",
								cwd: "/tmp",
							},
							{
								type: "message",
								id: "entry-1",
								parentId: null,
								timestamp: "2026-01-01T00:00:01.000Z",
								message: { role: "user", content: "hi" },
							},
						);
					},
				};
			},
		};
		const reader = new ProcessSessionReader(source);

		const instanceTreePromise = reader.readInstanceTree("agt_1");
		const piTreePromise = reader.readPiSessionTree("agt_1");
		await Promise.resolve();
		expect(loads).toBe(1);
		releaseLoad?.();
		const [instanceTree, piTree] = await Promise.all([instanceTreePromise, piTreePromise]);

		expect([...instanceTree.entriesById.keys()]).toEqual(["entry-1"]);
		expect(piTree.entries.map((entry) => entry.id)).toEqual(["entry-1"]);
		expect(loads).toBe(1);
	});

	it("reuses the parsed Pi session tree while the signature is unchanged", async () => {
		const controllable = createControllableSource();
		controllable.set(
			"agt_1",
			"sig-1",
			jsonl(
				{ type: "session", id: "sess_1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "hi", timestamp: 1 },
				},
			),
		);
		const reader = new ProcessSessionReader(controllable.source);

		const first = await reader.readPiSessionTree("agt_1");
		const second = await reader.readPiSessionTree("agt_1");

		expect(first).toBe(second);
		expect(first.entries).toHaveLength(1);
		expect(controllable.loadCount("agt_1")).toBe(1);
	});

	it("returns an empty Pi session tree when no session exists", async () => {
		const controllable = createControllableSource();
		const reader = new ProcessSessionReader(controllable.source);

		const tree = await reader.readPiSessionTree("missing");

		expect(tree.entries).toEqual([]);
		expect(tree.leafId).toBeNull();
	});

	it("returns raw content or null when the session is absent", async () => {
		const controllable = createControllableSource();
		controllable.set("agt_1", "sig-1", "raw-content\n");
		const reader = new ProcessSessionReader(controllable.source);

		expect(await reader.readRawContent("agt_1")).toBe("raw-content\n");
		expect(await reader.readRawContent("missing")).toBeNull();
	});
});

describe("file-backed process session snapshot store", () => {
	it("atomically stores and reads the latest raw snapshot", async () => {
		const root = await createTempRoot();
		const store = createFileBackedProcessSessionSnapshotStore(root);
		const content = jsonl({ type: "message", id: "entry-1", parentId: null });

		const result = await store.writeSnapshot("agt_1", content);

		expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
		expect(await store.readRawSnapshot("agt_1")).toBe(content);
		expect(await readFile(path.join(root, "agt_1.jsonl"), "utf8")).toBe(content);
	});

	it("deletes snapshots safely and idempotently", async () => {
		const root = await createTempRoot();
		const store = createFileBackedProcessSessionSnapshotStore(root);
		await store.writeSnapshot("agt_delete", "content\n");

		await store.deleteSnapshot("agt_delete");
		await store.deleteSnapshot("agt_delete");

		expect(await store.readRawSnapshot("agt_delete")).toBeNull();
	});

	it("rejects unsafe instance ids before resolving filesystem paths", async () => {
		const root = await createTempRoot();
		const store = createFileBackedProcessSessionSnapshotStore(root);

		expect(isSafeSessionInstanceId("agt_ok-1.2")).toBe(true);
		expect(isSafeSessionInstanceId("../agt_1")).toBe(false);
		await expect(store.writeSnapshot("../agt_1", "content")).rejects.toThrow(
			/Invalid process session instance id/,
		);
	});
});

describe("createFilesystemSessionSource", () => {
	it("reads instance trees from <treeFilesDir>/<instanceId>.jsonl", async () => {
		const root = await createTempRoot();
		await writeInstanceTree(
			root,
			"agt_1",
			jsonl(
				{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
				},
			),
		);
		const reader = createFilesystemSessionReader(root);

		const tree = await reader.readInstanceTree("agt_1");

		expect([...tree.entriesById.keys()]).toEqual(["entry-1"]);
	});

	it("returns null handle for a missing session file", async () => {
		const root = await createTempRoot();
		const source = createFilesystemSessionSource(root);

		expect(await source.readSnapshotHandle("missing")).toBeNull();
	});

	it("changes its signature when the file content changes", async () => {
		const root = await createTempRoot();
		await writeInstanceTree(root, "agt_1", jsonl({ type: "message", id: "a", parentId: null }));
		const source = createFilesystemSessionSource(root);

		const firstHandle = await source.readSnapshotHandle("agt_1");
		await writeInstanceTree(
			root,
			"agt_1",
			jsonl(
				{ type: "message", id: "a", parentId: null },
				{ type: "message", id: "b", parentId: "a" },
			),
		);
		const secondHandle = await source.readSnapshotHandle("agt_1");

		expect(firstHandle?.signature).toBeDefined();
		expect(secondHandle?.signature).toBeDefined();
		expect(secondHandle?.signature).not.toBe(firstHandle?.signature);
	});

	it("re-parses same-length replacement content with an unchanged mtime", async () => {
		const root = await createTempRoot();
		const treeFile = path.join(root, "agt_1.jsonl");
		const firstContent = jsonl(
			{
				type: "session",
				version: 3,
				id: "sess_1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: "one", timestamp: 1 },
			},
		);
		const secondContent = jsonl(
			{
				type: "session",
				version: 3,
				id: "sess_1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			{
				type: "message",
				id: "entry-2",
				parentId: null,
				timestamp: "2026-01-01T00:00:02.000Z",
				message: { role: "user", content: "two", timestamp: 2 },
			},
		);
		expect(Buffer.byteLength(secondContent)).toBe(Buffer.byteLength(firstContent));
		await writeInstanceTree(root, "agt_1", firstContent);
		const fixedTime = new Date("2026-01-01T00:00:00.000Z");
		await utimes(treeFile, fixedTime, fixedTime);
		const originalTimes = await stat(treeFile);
		const originalCtimeNs = (await stat(treeFile, { bigint: true })).ctimeNs;
		const reader = createFilesystemSessionReader(root);

		const first = await reader.readInstanceTree("agt_1");
		let replacementCtimeNs = originalCtimeNs;
		for (let attempt = 0; attempt < 100 && replacementCtimeNs === originalCtimeNs; attempt += 1) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10));
			await writeInstanceTree(root, "agt_1", secondContent);
			await utimes(treeFile, originalTimes.atime, originalTimes.mtime);
			replacementCtimeNs = (await stat(treeFile, { bigint: true })).ctimeNs;
		}
		expect(replacementCtimeNs).not.toBe(originalCtimeNs);
		expect((await stat(treeFile)).mtimeMs).toBe(originalTimes.mtimeMs);
		const second = await reader.readInstanceTree("agt_1");

		expect([...first.entriesById.keys()]).toEqual(["entry-1"]);
		expect([...second.entriesById.keys()]).toEqual(["entry-2"]);
	});
});
