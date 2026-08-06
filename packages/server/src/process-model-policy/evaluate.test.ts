import { describe, expect, it } from "vitest";
import {
	createModelAvailabilitySnapshot,
	createTestModelPolicy,
	createTestProcessInstance,
	createTestTurnStart,
} from "../test-helpers/process-model-fixtures.js";

function resolve(
	processInstance: ReturnType<typeof createTestProcessInstance>,
	options: {
		override?: string | null;
		mode?: "resolve" | "initial" | "retry" | "continue";
		availability?: ReturnType<typeof createModelAvailabilitySnapshot>;
	} = {},
) {
	return {
		kind: "process_turn" as const,
		process: processInstance,
		availability: options.availability ?? createModelAvailabilitySnapshot(),
		turnId: "run",
		...(options.mode === "initial" ? { initialSelection: true } : {}),
		...(options.mode === "retry" || options.mode === "continue" ? { startKind: options.mode } : {}),
		...(Object.hasOwn(options, "override") ? { modelOverride: options.override ?? null } : {}),
	};
}

const availability = (first = "available" as const, second = "available" as const, revision = 1) =>
	createModelAvailabilitySnapshot(
		[
			{ profileId: "first", modelId: "one", availability: first },
			{ profileId: "second", modelId: "two", availability: second },
		],
		revision,
	);

describe("server process model policy evaluate", () => {
	it("exposes only domain-subject operations", () => {
		const policy = createTestModelPolicy().policy;
		expect(Object.keys(policy).sort()).toEqual([
			"evaluate",
			"fingerprint",
			"inspectPersistedState",
			"prepareLaunchPlan",
			"project",
		]);
	});

	it("never falls back from an unavailable explicit selection", () => {
		const { policy } = createTestModelPolicy();
		const result = policy.evaluate(
			resolve(createTestProcessInstance(), {
				override: "first",
				availability: availability("unavailable"),
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "model_unavailable",
			selection: { modelProfileId: "first", provenance: { kind: "explicit" } },
		});
	});

	it("preserves launch override provenance when evaluating a launch plan", () => {
		const { policy } = createTestModelPolicy();
		const result = policy.evaluate({
			kind: "launch_plan_turn",
			plan: {
				launcherId: "test",
				processId: "policy",
				processInput: {
					processId: "policy",
					selectedTurnId: "run",
					selectedTurnModelProfileId: "second",
					lifecycleStatus: "discovered",
					paramsJson: null,
					stateJson: null,
					turnConfigsJson: null,
				},
				projectInputs: [],
				startTurnId: "run",
			},
			turnId: "run",
			availability: availability(),
		});

		expect(result).toMatchObject({
			ok: true,
			selection: {
				modelProfileId: "second",
				provenance: { kind: "explicit", source: "launch_override" },
			},
		});
	});

	it("uses a configured purpose profile instead of launch and action overrides", () => {
		const { policy } = createTestModelPolicy({ purposeProfileId: "first" });
		expect(
			policy.evaluate(
				resolve(createTestProcessInstance(), {
					override: "second",
					availability: availability(),
				}),
			),
		).toMatchObject({ ok: true, selection: { modelProfileId: "first" } });
		expect(
			policy.evaluate({
				kind: "launch_plan_turn",
				plan: {
					launcherId: "test",
					processId: "policy",
					processInput: {
						processId: "policy",
						selectedTurnId: "run",
						selectedTurnModelProfileId: "second",
						lifecycleStatus: "discovered",
						paramsJson: null,
						stateJson: null,
						turnConfigsJson: null,
					},
					projectInputs: [],
					startTurnId: "run",
				},
				turnId: "run",
				availability: availability(),
			}),
		).toMatchObject({ ok: true, selection: { modelProfileId: "first" } });
	});

	it("uses normal inherited resolution when a purpose has no configured profile", () => {
		const { policy } = createTestModelPolicy({ modelPurpose: true });
		expect(policy.evaluate(resolve(createTestProcessInstance()))).toMatchObject({
			ok: true,
			selection: { modelProfileId: "first" },
		});
	});

	it("blocks invalid explicit instance candidates without fallback", () => {
		const { policy } = createTestModelPolicy();
		const result = policy.evaluate(
			resolve(
				createTestProcessInstance({
					turnConfigsJson: JSON.stringify({ run: { modelProfileId: "removed" } }),
				}),
				{ availability: availability() },
			),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "unknown_model_profile",
			selection: { provenance: { kind: "explicit", source: "instance_turn_config" } },
		});
	});

	it("re-resolves invalid inherited server defaults", () => {
		for (const configured of [
			{ processTurnProfileId: "removed" },
			{ processDefaultProfileId: "removed" },
			{ processTurnProfileId: "first", allowedProfileIds: ["second"] },
			{ processDefaultProfileId: "first", allowedProfileIds: ["second"] },
		]) {
			const { policy } = createTestModelPolicy(configured);
			expect(policy.evaluate(resolve(createTestProcessInstance()))).toMatchObject({
				ok: true,
				selection: {
					modelProfileId: configured.allowedProfileIds ? "second" : "first",
					provenance: { kind: "inherited", source: "catalog_default" },
				},
			});
		}
	});

	it("allows startup recovery from a fresh lower process-local availability revision", () => {
		const { policy } = createTestModelPolicy();
		const currentStart = createTestTurnStart({
			state: {
				kind: "preparation_failed",
				requestedModelProfileId: "first",
				providerOptions: {},
				code: "model_unavailable",
				safeSummary: "Unavailable before restart",
				modelSelectionProvenance: { kind: "inherited", source: "catalog_default" },
				availabilityRevision: 5,
			},
		});
		const freshAvailability = availability("available", "available", 1);

		expect(
			policy.evaluate({
				kind: "preparation_recovery",
				cause: "startup_reconciliation",
				process: createTestProcessInstance(),
				currentStart,
				availability: freshAvailability,
			}),
		).toMatchObject({ ok: true, selection: { modelProfileId: "first" } });
		expect(
			policy.evaluate({
				kind: "preparation_recovery",
				cause: "availability_transition",
				process: createTestProcessInstance(),
				currentStart,
				availability: freshAvailability,
			}),
		).toMatchObject({
			ok: false,
			code: "model_unavailable",
			reason: "This start is not eligible for automatic model recovery",
		});
	});

	it("re-resolves inherited startup failures after the old default is removed", () => {
		const { policy } = createTestModelPolicy({
			profiles: [{ id: "local_qwen" }],
			processDefaultProfileId: "local_qwen",
		});
		const process = createTestProcessInstance({
			selectedTurnModelProfileId: "claude_fast",
			selectedTurnModelKind: "inherited",
			selectedTurnModelSource: "process_config_default",
		});
		const currentStart = createTestTurnStart({
			state: {
				kind: "preparation_failed",
				requestedModelProfileId: "claude_fast",
				providerOptions: {},
				code: "model_unavailable",
				safeSummary: "Unavailable before restart",
				modelSelectionProvenance: {
					kind: "inherited",
					source: "process_config_default",
				},
				availabilityRevision: 5,
			},
		});

		expect(
			policy.evaluate({
				kind: "preparation_recovery",
				cause: "startup_reconciliation",
				process,
				currentStart,
				availability: createModelAvailabilitySnapshot([{ profileId: "local_qwen" }], 1),
			}),
		).toMatchObject({
			ok: true,
			selection: {
				modelProfileId: "local_qwen",
				provenance: { kind: "inherited", source: "process_config_default" },
			},
		});
	});

	it("retains explicit selections for the initial start, Retry, and Continue", () => {
		const { policy } = createTestModelPolicy();
		const explicit = createTestProcessInstance({
			selectedTurnModelProfileId: "second",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "action_override",
		});
		for (const mode of ["initial", "retry", "continue"] as const)
			expect(
				policy.evaluate(resolve(explicit, { mode, availability: availability() })),
			).toMatchObject({
				ok: true,
				selection: { modelProfileId: "second" },
			});
		expect(policy.evaluate(resolve(explicit, { availability: availability() }))).toMatchObject({
			ok: true,
			selection: { modelProfileId: "first" },
		});
		const inherited = {
			...explicit,
			selectedTurnModelKind: "inherited" as const,
			selectedTurnModelSource: "catalog_default" as const,
		};
		for (const mode of ["retry", "continue"] as const)
			expect(
				policy.evaluate(resolve(inherited, { mode, availability: availability() })),
			).toMatchObject({
				ok: true,
				selection: { modelProfileId: "first" },
			});
	});

	it("is isolated from mutation of construction inputs", () => {
		const { config, policy } = createTestModelPolicy();
		const firstProfile = config.pi.model_profiles[0];
		if (!firstProfile) throw new Error("missing fixture profile");
		firstProfile.id = "mutated";
		expect(
			policy.project({
				kind: "profile_options",
				processId: "policy",
				availability: availability(),
			}),
		).toMatchObject([{ id: "first" }, { id: "second" }]);
	});
});
