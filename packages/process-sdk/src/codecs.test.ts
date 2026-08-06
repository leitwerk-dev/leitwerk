import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";

describe("codecs", () => {
	it("parses empty params as an empty object", () => {
		expect(emptyParamsCodec.parse(null)).toEqual({});
		expect(emptyParamsCodec.parse({ anything: true })).toEqual({});
	});

	it("serializes empty params without mutation", () => {
		const value = {} as Record<string, never>;
		expect(emptyParamsCodec.serialize(value)).toBe(value);
	});
});
