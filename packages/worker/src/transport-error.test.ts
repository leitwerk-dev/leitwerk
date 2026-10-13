import { describe, expect, it } from "vitest";
import { transportErrorCode, transportErrorDetails } from "./transport-error.js";

describe("safe transport error details", () => {
	it.each([
		"ENOTFOUND",
		"ECONNRESET",
		"CERT_HAS_EXPIRED",
		"UND_ERR_CONNECT_TIMEOUT",
	])("retains nested %s without native messages", (code) => {
		const cause = Object.assign(
			new Error("https://secret-token@host/private?token=secret-token BODY"),
			{ code, hostname: "private-host", token: "secret-token" },
		);
		const error = new TypeError("fetch secret-token failed", { cause });
		expect(transportErrorDetails(error)).toEqual({
			causes: [{ name: "TypeError" }, { name: "Error", code, parent: 0 }],
		});
		expect(transportErrorCode(error)).toBe(code);
		expect(JSON.stringify(transportErrorDetails(error))).not.toMatch(
			/secret-token|private-host|https|BODY/,
		);
	});
	it("drops unrecognized names and codes rather than serializing arbitrary error data", () => {
		expect(
			transportErrorDetails({
				name: "secret-token",
				code: "https://private",
				message: "BODY",
				stack: "SECRET",
			}),
		).toEqual({ causes: [{}] });
	});
	it("bounds aggregate children, total nodes, depth and cyclic causes", () => {
		const errors = Array.from({ length: 20 }, () =>
			Object.assign(new Error("SECRET"), { code: "ECONNREFUSED" }),
		);
		const aggregate = new AggregateError(errors, "SECRET");
		const root = new TypeError("SECRET", { cause: aggregate });
		Object.assign(errors[0], { cause: root });
		const details = transportErrorDetails(root);
		expect(details.causes).toHaveLength(6);
		expect(details.truncated).toBe(true);
		let deep: Error = new Error("SECRET");
		for (let i = 0; i < 20; i++) deep = new Error("SECRET", { cause: deep });
		expect(transportErrorDetails(deep)).toEqual({
			causes: [
				{ name: "Error" },
				{ name: "Error", parent: 0 },
				{ name: "Error", parent: 1 },
				{ name: "Error", parent: 2 },
				{ name: "Error", parent: 3 },
				{ name: "Error", parent: 4 },
			],
			truncated: true,
		});
		expect(JSON.stringify(details)).not.toContain("SECRET");
	});
});
