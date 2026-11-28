import { describe, expect, it } from "vitest";
import { deserializeManifest, serializeManifest } from "./manifest.js";

describe("serializeManifest / deserializeManifest", () => {
	it("serializes all manifest fields and reads independently encoded JSON", () => {
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
		expect(JSON.parse(serializeManifest(m))).toEqual(m);
		const d = deserializeManifest(JSON.stringify(m));
		expect(d).toEqual({ ok: true, manifest: m });
	});

	it("rejects invalid JSON", () => {
		expect(deserializeManifest("not json")).toEqual({
			ok: false,
			error: expect.any(String),
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
		).toEqual({ ok: false, error: expect.any(String) });
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
