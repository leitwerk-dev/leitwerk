import { describe, expect, it } from "vitest";
import { deserializeManifest, diffManifest, serializeManifest } from "./manifest.js";

describe("serializeManifest / deserializeManifest", () => {
	it("round-trips valid manifest", () => {
		const m = {
			version: 1 as const,
			instanceId: "x",
			createdAt: "2020-01-01T00:00:00.000Z",
			components: [
				{
					key: "k",
					repoLocator: "u",
					baseBranch: "t",
					workBranch: "f",
					clonedAt: "2020-01-01T00:00:00.000Z",
					headSha: "abc",
				},
			],
		};
		const json = serializeManifest(m);
		expect(json).toContain("\n  ");
		const d = deserializeManifest(json);
		expect(d).toEqual({ ok: true, manifest: m });
	});

	it("rejects invalid JSON", () => {
		expect(deserializeManifest("not json")).toEqual({
			ok: false,
			error: "Invalid JSON",
		});
	});

	it("rejects wrong version", () => {
		expect(
			deserializeManifest(
				JSON.stringify({
					version: 2,
					instanceId: "a",
					createdAt: "t",
					components: [],
				}),
			),
		).toEqual({ ok: false, error: "Unsupported manifest version" });
	});

	it("rejects invalid components", () => {
		expect(
			deserializeManifest(
				JSON.stringify({
					version: 1,
					instanceId: "a",
					createdAt: "t",
					components: [{}],
				}),
			).ok,
		).toBe(false);
	});
});

describe("diffManifest", () => {
	const server = [
		{
			key: "a",
			repoLocator: "r1",
			baseBranch: "main",
			workBranch: "f1",
		},
		{
			key: "b",
			repoLocator: "r2",
			baseBranch: "main",
			workBranch: "f2",
		},
	];

	it("classifies unchanged and stale", () => {
		const existing = {
			version: 1 as const,
			instanceId: "ag",
			createdAt: "t",
			components: [
				{
					key: "a",
					repoLocator: "r1",
					baseBranch: "main",
					workBranch: "f1",
					clonedAt: "c",
					headSha: "h",
				},
				{
					key: "b",
					repoLocator: "old",
					baseBranch: "main",
					workBranch: "f2",
					clonedAt: "c",
					headSha: "h",
				},
			],
		};
		const d = diffManifest(existing, server);
		expect(d.unchanged).toEqual(["a"]);
		expect(d.stale).toEqual(["b"]);
		expect(d.missing).toEqual([]);
		expect(d.extra).toEqual([]);
	});

	it("detects missing and extra keys", () => {
		const existing = {
			version: 1 as const,
			instanceId: "ag",
			createdAt: "t",
			components: [
				{
					key: "a",
					repoLocator: "r1",
					baseBranch: "main",
					workBranch: "f1",
					clonedAt: "c",
					headSha: "h",
				},
				{
					key: "orphan",
					repoLocator: "x",
					baseBranch: "main",
					workBranch: "f",
					clonedAt: "c",
					headSha: "h",
				},
			],
		};
		const d = diffManifest(existing, [server[0]]);
		expect(d.missing).toEqual([]);
		expect(d.extra).toEqual(["orphan"]);
		expect(d.unchanged).toEqual(["a"]);
	});

	it("marks server-only keys as missing", () => {
		const existing = {
			version: 1 as const,
			instanceId: "ag",
			createdAt: "t",
			components: [
				{
					key: "a",
					repoLocator: "r1",
					baseBranch: "main",
					workBranch: "f1",
					clonedAt: "c",
					headSha: "h",
				},
			],
		};
		const d = diffManifest(existing, server);
		expect(d.missing).toEqual(["b"]);
		expect(d.extra).toEqual([]);
	});
});
