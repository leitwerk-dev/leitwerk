import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	parseFutureActionPayloadJson,
	parseFutureLaunchPayloadJson,
	serializeFutureActionPayload,
	serializeFutureLaunchPayload,
} from "./http-contracts.js";

describe("future action payload actor attribution", () => {
	it("round-trips a normalized actor", () => {
		const parsed = parseFutureActionPayloadJson(
			serializeFutureActionPayload({
				input: { approved: true },
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
				actor: ADMIN_ACTOR,
			}),
		);

		expect(parsed).toEqual({
			ok: true,
			value: {
				input: { approved: true },
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
				actor: ADMIN_ACTOR,
			},
		});
	});

	it("keeps legacy payloads without actors readable", () => {
		const parsed = parseFutureActionPayloadJson(
			JSON.stringify({ input: {}, nextTurnModelProfileId: null, actionLabel: "Approve plan" }),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.actor).toBeNull();
	});
});

describe("future launch payload actor attribution", () => {
	function launchPayloadObject(actor?: unknown) {
		return {
			launcherInput: { repoPath: "/tmp/demo" },
			modelConfig: {},
			...(actor ? { actor } : {}),
			launchPlan: {
				launcherId: "demo.launcher",
				processId: "demo_process",
				processInput: {
					processId: "demo_process",
					selectedTurnId: null,
					lifecycleStatus: "discovered",
					paramsJson: "{}",
					stateJson: "{}",
				},
				projectInputs: [],
				startTurnId: null,
			},
		};
	}

	it("round-trips a normalized actor", () => {
		const parsed = parseFutureLaunchPayloadJson(
			serializeFutureLaunchPayload(launchPayloadObject(ADMIN_ACTOR)),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.actor).toEqual(ADMIN_ACTOR);
	});

	it("round-trips server-owned resource selections outside the extension launch plan", () => {
		const parsed = parseFutureLaunchPayloadJson(
			serializeFutureLaunchPayload({
				...launchPayloadObject(),
				resourceSelections: [{ skillId: "review", revisionId: "skillrev_1" }],
			}),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.resourceSelections).toEqual([
			{ skillId: "review", revisionId: "skillrev_1" },
		]);
		expect(parsed.value.launchPlan).not.toHaveProperty("resourceSelections");
	});

	it("keeps legacy payloads without actors readable", () => {
		const parsed = parseFutureLaunchPayloadJson(JSON.stringify(launchPayloadObject()));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.actor).toBeNull();
	});
});
