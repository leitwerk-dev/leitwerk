import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SESSION_TRANSFER_LIMITS } from "@leitwerk-dev/session-transfer";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemProcessStateExporter } from "./filesystem-process-state-exporter.js";
import { createExportTestFixture } from "./session-transfer.test-helper.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-filesystem-export-"));
	roots.push(root);
	const storageRoot = path.join(root, "storage");
	const storageAlias = path.join(root, "storage-link");
	await mkdir(path.join(storageRoot, "workspace"), { recursive: true });
	await symlink(storageRoot, storageAlias);
	const workspaceContent = "retained workspace\n";
	const sessionContent = "retained session\n";
	await writeFile(path.join(storageRoot, "workspace", "README.md"), workspaceContent);
	await writeFile(path.join(storageRoot, "primary.jsonl"), sessionContent);
	const source = {
		workspaceRoot: path.join(storageAlias, "workspace"),
		sessionFile: path.join(storageAlias, "primary.jsonl"),
	};
	const { manifest } = createExportTestFixture();
	return {
		root,
		storageRoot,
		storageAlias,
		source,
		workspaceContent,
		sessionContent,
		request: {
			instanceId: manifest.instanceId,
			manifest,
			limits: DEFAULT_SESSION_TRANSFER_LIMITS,
		},
	};
}

describe("filesystem process state export confinement", () => {
	it("accepts retained storage reached through a configured directory symlink", async () => {
		const input = await fixture();
		const exporter = createFilesystemProcessStateExporter({
			allowedRoots: [input.storageAlias],
			resolveSource: () => input.source,
		});

		await expect(exporter.prepare(input.request)).resolves.toMatchObject({
			preflight: {
				entriesTotal: 4,
				logicalBytesTotal: Buffer.byteLength(input.workspaceContent + input.sessionContent),
			},
		});
	});

	it.each([
		"workspaceRoot",
		"sessionFile",
	] as const)("rejects a %s symlink that escapes the configured storage root", async (sourcePath) => {
		const input = await fixture();
		const outside = path.join(input.root, "storage-outside");
		if (sourcePath === "workspaceRoot") {
			await mkdir(outside);
		} else {
			await writeFile(outside, "unrelated session\n");
		}
		const escapingPath = path.join(input.storageRoot, "escape");
		await symlink(outside, escapingPath);
		const exporter = createFilesystemProcessStateExporter({
			allowedRoots: [input.storageAlias],
			resolveSource: () => ({ ...input.source, [sourcePath]: escapingPath }),
		});

		await expect(exporter.prepare(input.request)).rejects.toThrow(
			"Transfer source escapes configured process storage roots",
		);
	});
});
