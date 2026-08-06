import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ResultImageStore } from "./result-image-store.js";

function createStore(rootDir: string): ResultImageStore {
	return new ResultImageStore({ rootDir });
}

describe("ResultImageStore", () => {
	it("atomically stores images by their content hash", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-result-store-content-"));
		const store = createStore(root);
		const bytes = Buffer.from([137, 80, 78, 71]);
		const input = {
			instanceId: "prc_1",
			turnRecordId: "trn_1",
			bytes,
			mimeType: "image/png" as const,
		};
		const first = await store.put(input);
		const retry = await store.put(input);
		const different = await store.put({ ...input, bytes: Buffer.from([...bytes, 1]) });
		const names = readdirSync(path.join(root, "prc_1", "trn_1"));

		expect(first.imageId).toBe(`img_${createHash("sha256").update(bytes).digest("hex")}.png`);
		expect(retry).toEqual(first);
		expect(different.imageId).not.toBe(first.imageId);
		expect(names.sort()).toEqual([different.imageId, first.imageId].sort());
		expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("deletes expired and orphaned process image directories", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-result-store-cleanup-"));
		for (const id of ["retained", "expired", "deleted"]) {
			mkdirSync(path.join(root, id), { recursive: true });
			writeFileSync(path.join(root, id, "sentinel"), id);
		}
		const store = createStore(root);

		const removed = await store.cleanupProcesses({
			retainedInstanceIds: new Set(["retained", "expired"]),
			expiredInstanceIds: new Set(["expired"]),
		});
		expect(removed.sort()).toEqual(["deleted", "expired"]);
		expect(existsSync(path.join(root, "retained"))).toBe(true);
		expect(existsSync(path.join(root, "expired"))).toBe(false);
		expect(existsSync(path.join(root, "deleted"))).toBe(false);

		await store.deleteProcess("retained");
		expect(existsSync(path.join(root, "retained"))).toBe(false);
	});
});
