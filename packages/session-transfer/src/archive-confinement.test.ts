import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTransferArchive, extractTransferArchive, scanPortableWorkspace } from "./archive.js";
import type { LeitwerkTransferManifestV1 } from "./format.js";

const roots: string[] = [];
const writableDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(writableDirectories.splice(0).map((directory) => chmod(directory, 0o700)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-transfer-confinement-"));
	roots.push(root);
	const workspaceRoot = path.join(root, "workspace");
	await mkdir(path.join(workspaceRoot, "sub"), { recursive: true });
	const sessionFile = path.join(root, "primary.jsonl");
	await writeFile(sessionFile, "session content\n");
	const manifest: LeitwerkTransferManifestV1 = {
		version: 1,
		instanceId: "agt_1",
		createdAt: "2026-09-01T00:00:00.000Z",
		session: { sourceCwd: workspaceRoot, cwdRelativeToWorkspace: "." },
		projects: [],
	};
	return { root, workspaceRoot, sessionFile, manifest };
}

describe("archive confinement and directory permissions", () => {
	it("rejects chained symlink escapes during export preflight", async () => {
		const source = await fixture();
		await symlink(".", path.join(source.workspaceRoot, "a"));
		await symlink("../a/../outside", path.join(source.workspaceRoot, "sub", "b"));
		await expect(scanPortableWorkspace(source)).rejects.toThrow("escapes the workspace");
	});

	it("rejects chained symlink escapes supplied by an archive", async () => {
		const source = await fixture();
		const preflight = await scanPortableWorkspace(source);
		preflight.entries.push(
			{ relativePath: "a", kind: "symlink", linkTarget: ".", mode: 0o777, mtimeMs: 0, size: 0 },
			{
				relativePath: "sub/b",
				kind: "symlink",
				linkTarget: "../a/../outside",
				mode: 0o777,
				mtimeMs: 0,
				size: 0,
			},
		);
		preflight.entriesTotal += 2;
		await expect(
			extractTransferArchive({
				compressed: createTransferArchive({ ...source, preflight }),
				outputRoot: path.join(source.root, "output"),
			}),
		).rejects.toThrow("escapes the workspace");
	});

	it("writes children before restoring read-only directory permissions", async () => {
		const source = await fixture();
		const sourceDirectory = path.join(source.workspaceRoot, "sub");
		await writeFile(path.join(sourceDirectory, "file.txt"), "retained content\n");
		await chmod(sourceDirectory, 0o555);
		writableDirectories.push(sourceDirectory);
		const outputRoot = path.join(source.root, "output");
		await extractTransferArchive({
			compressed: createTransferArchive({
				...source,
				preflight: await scanPortableWorkspace(source),
			}),
			outputRoot,
		});
		const importedDirectory = path.join(outputRoot, "workspace", "sub");
		writableDirectories.push(importedDirectory);
		expect(await readFile(path.join(importedDirectory, "file.txt"), "utf8")).toBe(
			"retained content\n",
		);
		expect((await stat(importedDirectory)).mode & 0o777).toBe(0o555);
	});
});
