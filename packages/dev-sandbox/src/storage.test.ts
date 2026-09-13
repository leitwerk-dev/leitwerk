import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { resetSandbox, sandboxDirectory } from "./storage.js";

test("reset removes only sandbox sessions and retains dedicated credentials and sibling data", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sandbox-reset-test-"));
	try {
		const sandbox = sandboxDirectory(root);
		for (const mode of ["scripted", "real"]) {
			await mkdir(path.join(sandbox, mode));
			await writeFile(path.join(sandbox, mode, "owned"), "sandbox");
		}
		await writeFile(path.join(sandbox, "model.json"), "dedicated");
		await writeFile(path.join(root, ".leitwerk", "other"), "keep");
		await resetSandbox(root);
		assert.equal(await readFile(path.join(sandbox, "model.json"), "utf8"), "dedicated");
		assert.equal(await readFile(path.join(root, ".leitwerk", "other"), "utf8"), "keep");
		await assert.rejects(readFile(path.join(sandbox, "scripted", "owned")), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("reset refuses symlinked storage", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sandbox-reset-test-"));
	try {
		const sandbox = sandboxDirectory(root);
		const outside = path.join(root, "outside");
		await mkdir(outside);
		await writeFile(path.join(outside, "keep"), "keep");
		await symlink(outside, path.join(sandbox, "scripted"));
		await assert.rejects(resetSandbox(root), /symlink/);
		assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "keep");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
