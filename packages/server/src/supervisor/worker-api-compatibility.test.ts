import { describe, expect, it } from "vitest";
import { checkWorkerApiCompatibility } from "./worker-api-compatibility.js";

describe("checkWorkerApiCompatibility", () => {
	it("accepts matching API versions", () => {
		expect(
			checkWorkerApiCompatibility(
				{ version: "0.1.0", apiVersion: "2026-06-23", capabilities: [] },
				"2026-06-23",
			),
		).toEqual({ ok: true });
	});

	it("accepts legacy hello payloads that do not report an API version", () => {
		expect(
			checkWorkerApiCompatibility({ version: "0.1.0", capabilities: [] }, "2026-06-23"),
		).toEqual({ ok: true });
	});

	it("rejects missing API versions when container runners require fail-fast compatibility", () => {
		expect(
			checkWorkerApiCompatibility({ version: "0.1.0", capabilities: [] }, "2026-06-23", {
				requireApiVersion: true,
			}),
		).toEqual({
			ok: false,
			error:
				"Worker API version is required, but none was reported; server API version is '2026-06-23'",
		});
	});

	it("rejects mismatched API versions", () => {
		expect(
			checkWorkerApiCompatibility(
				{ version: "0.1.0", apiVersion: "old", capabilities: [] },
				"2026-06-23",
			),
		).toEqual({
			ok: false,
			error: "Worker API version 'old' is incompatible with server API version '2026-06-23'",
		});
	});
});
