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

	it("bounds step logs by lines and UTF-8 bytes", async () => {
		const encode = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify([
							{ line: 1, data: encode("old") },
							{ line: 2, data: encode("line") },
							{ line: 3, data: [...new TextEncoder().encode("🙂🙂🙂")] },
						]),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);
		const client = new WoodpeckerClient({
			baseUrl: "https://ci.example.test",
			token: "token",
		});

		const result = await client.getStepLogs(4, 12, 7, 2, 9);

		expect(result.logs).toBe("🙂🙂");
		expect(result.truncated).toBe(true);
	});

	it("uses the Woodpecker 3 pipeline restart endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ number: 13 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
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
