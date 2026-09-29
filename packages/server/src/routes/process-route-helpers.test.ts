import { describe, expect, it } from "vitest";
import {
	normalizeContinueRequest,
	normalizeRecoveryModelRequest,
} from "./process-route-helpers.js";

describe("recovery model request normalization", () => {
	it("accepts bounded provider options for Retry and startup Retry", () => {
		expect(
			normalizeRecoveryModelRequest({
				nextTurnModelProfileId: " profile ",
				providerOptions: { preferredAccount: "team-a" },
			}),
		).toEqual({
			ok: true,
			request: {
				nextTurnModelProfileId: "profile",
				providerOptions: { preferredAccount: "team-a" },
			},
		});
	});

	it("keeps omitted provider options distinct from an explicit empty bag", () => {
		expect(normalizeRecoveryModelRequest({})).toEqual({
			ok: true,
			request: {},
		});
		expect(normalizeRecoveryModelRequest({ providerOptions: {} })).toEqual({
			ok: true,
			request: {
				providerOptions: {},
			},
		});
	});

	it.each([null, undefined, ""])("preserves explicit model reset %j", (value) => {
		expect(normalizeRecoveryModelRequest({ nextTurnModelProfileId: value })).toEqual({
			ok: true,
			request: { nextTurnModelProfileId: null },
		});
	});

	it("keeps omitted continuation prompts distinct from an explicit reset", () => {
		expect(normalizeContinueRequest({})).toEqual({ ok: true, request: {} });
		for (const prompt of [null, undefined]) {
			expect(normalizeContinueRequest({ prompt })).toEqual({ ok: true, request: { prompt: null } });
		}
	});

	it.each([
		[null, "must be an object of string values"],
		[undefined, "must be an object of string values"],
		[[], "must be an object of string values"],
		[{ account: 7 }, "contains an invalid field"],
		[{ "": "account" }, "contains an invalid field"],
		[{ ["k".repeat(129)]: "account" }, "contains an invalid field"],
		[{ account: "a".repeat(4097) }, "contains an invalid field"],
		[
			Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), ""])),
			"has too many fields",
		],
	])("rejects malformed provider options %j", (providerOptions, reason) => {
		expect(normalizeRecoveryModelRequest({ providerOptions })).toEqual({
			ok: false,
			error: `providerOptions ${reason}`,
		});
	});

	it.each([
		[[], "continue request body must be an object"],
		[
			{ unknown: true },
			"continue request body must use { prompt, nextTurnModelProfileId, providerOptions }",
		],
		[{ nextTurnModelProfileId: 7 }, "nextTurnModelProfileId must be a string or null"],
		[{ prompt: 7 }, "prompt must be a string or null"],
	])("rejects invalid Continue requests %j", (body, error) => {
		expect(normalizeContinueRequest(body)).toEqual({ ok: false, error });
	});

	it("accepts model and provider option overrides on Continue", () => {
		expect(
			normalizeContinueRequest({
				prompt: "Continue",
				nextTurnModelProfileId: "next",
				providerOptions: { region: "eu" },
			}),
		).toMatchObject({
			ok: true,
			request: {
				prompt: "Continue",
				nextTurnModelProfileId: "next",
				providerOptions: { region: "eu" },
			},
		});
	});
});
