import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTransferArchive,
	extractTransferArchive,
	type LeitwerkTransferManifestV1,
	parseSessionTransferHelperSpec,
	parseTransferLink,
	rewritePiSession,
	scanPortableWorkspace,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-transfer-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	await mkdir(path.join(workspace, "repo", ".git"), { recursive: true });
	await writeFile(path.join(workspace, "repo", "dirty.txt"), "working tree\n", { mode: 0o755 });
	await symlink("dirty.txt", path.join(workspace, "repo", "safe-link"));
	const session = path.join(root, "primary.jsonl");
	await writeFile(
		session,
		`${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: new Date().toISOString(), cwd: workspace, parentSession: "/source/parent.jsonl" })}\n${JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello", timestamp: Date.now() } })}\n`,
	);
	const manifest: LeitwerkTransferManifestV1 = {
		version: 1,
		instanceId: "agt_1",
		createdAt: new Date().toISOString(),
		session: { sourceCwd: workspace, cwdRelativeToWorkspace: "." },
		projects: [],
	};
	return { root, workspace, session, manifest };
}

describe("session transfer format", () => {
	it("keeps bearer tokens in the URL fragment and rejects non-loopback HTTP", () => {
		expect(
			parseTransferLink(
				"https://leitwerk.example/api/session-transfers/agt_1/trg_1#token=abcdefghijklmnopqrstuvwxyz123456",
			).token,
		).toBe("abcdefghijklmnopqrstuvwxyz123456");
		expect(() =>
			parseTransferLink(
				"http://leitwerk.example/api/session-transfers/agt_1/trg_1#token=abcdefghijklmnopqrstuvwxyz123456",
			),
		).toThrow("require HTTPS");
	});

	it("rejects transfer ids that decode into path separators", () => {
		expect(() =>
			parseTransferLink(
				"https://leitwerk.example/api/session-transfers/agt%2Fescape/trg_1#token=abcdefghijklmnopqrstuvwxyz123456",
			),
		).toThrow("invalid instance id");
	});

	it("validates helper specs with the shared transfer schemas", async () => {
		const { manifest } = await fixture();
		expect(
			parseSessionTransferHelperSpec({
				manifest,
				limits: { maxEntries: 10, maxLogicalBytes: 20, maxCompressedBytes: 30 },
			}),
		).toMatchObject({ manifest, limits: { maxEntries: 10 } });
		expect(() =>
			parseSessionTransferHelperSpec({
				manifest,
				limits: { maxEntries: 0, maxLogicalBytes: 20, maxCompressedBytes: 30 },
			}),
		).toThrow();
	});

	it("round-trips regular files, modes, and safe symlinks through tar.zstd", async () => {
		const source = await fixture();
		const preflight = await scanPortableWorkspace({
			workspaceRoot: source.workspace,
			sessionFile: source.session,
		});
		const archive = createTransferArchive({
			workspaceRoot: source.workspace,
			sessionFile: source.session,
			manifest: source.manifest,
			preflight,
		});
		const output = path.join(source.root, "output");
		const result = await extractTransferArchive({ compressed: archive, outputRoot: output });
		expect(result.manifest.instanceId).toBe("agt_1");
		expect(await readFile(path.join(output, "workspace", "repo", "dirty.txt"), "utf8")).toBe(
			"working tree\n",
		);
		expect(await readlink(path.join(output, "workspace", "repo", "safe-link"))).toBe("dirty.txt");
		expect(result.compressedBytes).toBeGreaterThan(0);
		expect(result.streamSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects symlinks that escape the workspace during preflight", async () => {
		const source = await fixture();
		await symlink("../../outside", path.join(source.workspace, "repo", "escape"));
		await expect(
			scanPortableWorkspace({ workspaceRoot: source.workspace, sessionFile: source.session }),
		).rejects.toThrow("escapes the workspace");
	});

	it("rejects the compressed stream when a source file disappears after preflight", async () => {
		const source = await fixture();
		const preflight = await scanPortableWorkspace({
			workspaceRoot: source.workspace,
			sessionFile: source.session,
		});
		await rm(path.join(source.workspace, "repo", "dirty.txt"));
		const archive = createTransferArchive({
			workspaceRoot: source.workspace,
			sessionFile: source.session,
			manifest: source.manifest,
			preflight,
		});
		await expect(buffer(archive)).rejects.toMatchObject({ code: "ENOENT" });
		expect(archive.destroyed).toBe(true);
	});

	it.each([
		"before streaming",
		"during streaming",
	])("rejects the compressed stream when cancelled %s", async (timing) => {
		const source = await fixture();
		await writeFile(path.join(source.workspace, "large.bin"), randomBytes(2 * 1024 * 1024));
		const preflight = await scanPortableWorkspace({
			workspaceRoot: source.workspace,
			sessionFile: source.session,
		});
		const controller = new AbortController();
		if (timing === "before streaming") controller.abort();
		const archive = createTransferArchive({
			workspaceRoot: source.workspace,
			sessionFile: source.session,
			manifest: source.manifest,
			preflight,
			signal: controller.signal,
		});
		if (timing === "during streaming") archive.once("data", () => controller.abort());
		await expect(buffer(archive)).rejects.toMatchObject({ name: "AbortError" });
		expect(archive.destroyed).toBe(true);
	});

	it("rewrites only location metadata and preserves unknown nested JSON values", async () => {
		const source = await fixture();
		const original = (await readFile(source.session, "utf8")).trim().split("\n").map(JSON.parse);
		original[0].unknown = { nested: [null, true, { value: "unchanged" }] };
		original[1].custom = { records: [{ model: "historical" }], nullable: null };
		const rewritten = rewritePiSession(
			`${original.map(JSON.stringify).join("\n")}\n`,
			"/local/project",
			source.workspace,
		);
		const [header, entry] = rewritten.content.trim().split("\n").map(JSON.parse);
		expect(header).toEqual({ ...original[0], cwd: "/local/project", parentSession: undefined });
		expect(entry).toEqual(original[1]);
	});

	it("accepts a header-only V3 session", () => {
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/source",
		};
		expect(rewritePiSession(`${JSON.stringify(header)}\n`, "/target", "/source")).toMatchObject({
			entryCount: 0,
			header: { ...header, cwd: "/target" },
		});
	});

	it("preserves independent fresh root branches in append order", () => {
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/source",
		};
		const entries = [
			{ type: "message", id: "first-root", parentId: null },
			{ type: "custom", id: "first-result", parentId: "first-root" },
			{ type: "message", id: "fresh-root", parentId: null },
			{ type: "custom", id: "fresh-result", parentId: "fresh-root" },
			{ type: "custom", id: "first-review", parentId: "first-result" },
		];
		const rewritten = rewritePiSession(
			`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"/target",
		);
		expect(rewritten.entryCount).toBe(entries.length);
		expect(
			rewritten.content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.slice(1),
		).toEqual(entries);
	});

	it.each([undefined, 1, 2, 4])("rejects unsupported Pi session version %s", (version) => {
		const header = {
			type: "session",
			...(version === undefined ? {} : { version }),
			id: "session-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/source",
		};
		expect(() => rewritePiSession(`${JSON.stringify(header)}\n`, "/target")).toThrow(
			"unsupported_pi_session_version",
		);
	});

	it.each([
		[
			"duplicate ids",
			[
				{ type: "message", id: "entry-1", parentId: null },
				{ type: "custom", id: "entry-1", parentId: "entry-1" },
			],
		],
		["orphan parents", [{ type: "message", id: "entry-1", parentId: "missing" }]],
		[
			"forward parents",
			[
				{ type: "message", id: "entry-1", parentId: null },
				{ type: "custom", id: "entry-2", parentId: "entry-3" },
				{ type: "custom", id: "entry-3", parentId: "entry-1" },
			],
		],
		["second headers", [{ type: "session", version: 3, id: "entry-1", parentId: null }]],
	])("rejects %s", (_label, entries) => {
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/source",
		};
		expect(() =>
			rewritePiSession(`${[header, ...entries].map(JSON.stringify).join("\n")}\n`, "/target"),
		).toThrow();
	});

	it("requires source cwd to match the manifest", () => {
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-09-01T00:00:00.000Z",
			cwd: "/source",
		};
		expect(() => rewritePiSession(`${JSON.stringify(header)}\n`, "/target", "/other")).toThrow(
			"does not match",
		);
	});
});
