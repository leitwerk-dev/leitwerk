import { describe, expect, it } from "vitest";
import { resolveProcessRef } from "./process-ref.js";

describe("resolveProcessRef", () => {
	const serverBaseUrl = "https://leitwerk.example.test/app";
	it("resolves plain ids against the current origin", () => {
		expect(resolveProcessRef({ processRef: "abc123", serverBaseUrl })).toMatchObject({
			id: "abc123",
			origin: "https://leitwerk.example.test",
		});
	});
	it("accepts UI and API URLs with query/hash but only uses them to extract ids", () => {
		expect(
			resolveProcessRef({
				processRef: "https://leitwerk.example.test/processes/p1?x=1#leaf",
				serverBaseUrl,
			}),
		).toMatchObject({
			id: "p1",
			origin: "https://leitwerk.example.test",
			apiUrl: "https://leitwerk.example.test/api/processes/p1",
		});
		expect(
			resolveProcessRef({
				processRef: "https://remote.example.test/api/processes/p2?x=1#leaf",
				serverBaseUrl,
			}),
		).toMatchObject({
			id: "p2",
			origin: "https://leitwerk.example.test",
			apiUrl: "https://leitwerk.example.test/api/processes/p2",
		});
	});
	it("rejects invalid URLs", () => {
		expect(() => resolveProcessRef({ processRef: "file:///tmp/p", serverBaseUrl })).toThrow(/http/);
		expect(() =>
			resolveProcessRef({ processRef: "https://u:p@example.test/processes/p", serverBaseUrl }),
		).toThrow(/Credentials/);
		expect(() =>
			resolveProcessRef({ processRef: "https://example.test/not/p", serverBaseUrl }),
		).toThrow(/processes/);
	});
});
