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

	it("rejects malformed provider option values before any mutation", () => {
		expect(normalizeRecoveryModelRequest({ providerOptions: { account: 7 } })).toEqual({
			ok: false,
			error: "providerOptions contains an invalid field",
		});
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
