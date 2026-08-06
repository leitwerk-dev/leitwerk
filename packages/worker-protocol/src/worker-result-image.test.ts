import { describe, expect, it } from "vitest";
import { buildManagedResultImagePath, parseManagedResultImagePath } from "./worker-result-image.js";

describe("managed result image paths", () => {
	it("builds and parses the shared path contract", () => {
		const path = buildManagedResultImagePath("prc_1", "trn_1", "img_1.png");
		expect(parseManagedResultImagePath(path)).toEqual({
			instanceId: "prc_1",
			turnRecordId: "trn_1",
			imageId: "img_1.png",
		});
	});

	it("rejects paths that cannot be served from managed storage", () => {
		expect(parseManagedResultImagePath("https://example.com/image.png")).toBeNull();
		expect(
			parseManagedResultImagePath("/api/processes/a/turn-records/b/result-images/c/extra"),
		).toBeNull();
		for (const path of [
			"/api/processes/../turn-records/trn_1/result-images/img_1.png",
			"/api/processes/prc_1/turn-records/./result-images/img_1.png",
			"/api/processes/prc_1/turn-records/trn_1/result-images/arbitrary.png",
			"/api/processes/prc_1/turn-records/trn_1/result-images/img_1.gif",
		]) {
			expect(parseManagedResultImagePath(path)).toBeNull();
		}
		expect(() => buildManagedResultImagePath("..", "trn_1", "img_1.png")).toThrow();
		expect(() => buildManagedResultImagePath("prc_1", "trn_1", "arbitrary.png")).toThrow();
	});
});
