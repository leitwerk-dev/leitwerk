import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWoodpeckerProfiles, WoodpeckerClient } from "./client.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("WoodpeckerClient", () => {
	it("validates server-owned profiles", () => {
		expect(
			parseWoodpeckerProfiles({
				profiles: {
					ci: { base_url: "https://ci.example.test/", token: " secret " },
				},
			}).get("ci"),
		).toEqual({
			baseUrl: "https://ci.example.test",
			token: "secret",
		});
		expect(() =>
			parseWoodpeckerProfiles({
				profiles: { bad: { base_url: "http://ci", token: "x" } },
			}),
		).toThrow(/HTTPS/);
	});

	it.each([
		[100, "line\n🙂🙂🙂"],
		[9, "🙂🙂"],
	] as const)("bounds step logs by lines and UTF-8 bytes (maxBytes: %i)", async (maxBytes, logs) => {
		const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json([
					{ line: 1, data: encode("old") },
					{ line: 2, data: encode("line") },
					{ line: 3, data: [...new TextEncoder().encode("🙂🙂🙂")] },
				]),
			),
		);
		const client = new WoodpeckerClient({
			baseUrl: "https://ci.example.test",
			token: "token",
		});

		expect(await client.getStepLogs(4, 12, 7, 2, maxBytes)).toEqual({ logs, truncated: true });
	});

	it("uses the Woodpecker 3 pipeline restart endpoint", async () => {
		const fetchMock = vi.fn(async () => Response.json({ number: 13 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new WoodpeckerClient({
			baseUrl: "https://ci.example.test",
			token: "token",
		});

		await client.restartPipeline(4, 12);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://ci.example.test/api/repos/4/pipelines/12",
			expect.objectContaining({ method: "POST" }),
		);
	});
});
