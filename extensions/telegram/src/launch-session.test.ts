import type { LauncherModelConfigSchemaLike, UiLauncherSummary } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import {
	applyLaunchFieldText,
	applyLaunchModelStepAction,
	applyLaunchModelStepText,
	beginLaunchModelEdit,
	buildLaunchInput,
	buildLaunchModelConfig,
	buildLaunchModelStepPrompt,
	createLaunchSession,
	currentLaunchField,
	currentLaunchModelStep,
	getLaunchFieldOptions,
	hasLaunchModelControls,
	moveLaunchSessionToValidationField,
	seedLaunchModelConfigFromPlan,
} from "./launch-session.js";

function launcher(): UiLauncherSummary {
	return {
		id: "test.launcher",
		processId: "test_process",
		displayName: "Test Process",
		label: "Test Launcher",
		description: "Launch a test process",
		card: {},
		launchConfigSchema: {
			id: "test_form",
			title: "Test Form",
			fields: [
				{ id: "prompt", label: "Prompt", kind: "textarea", required: true },
				{ id: "count", label: "Count", kind: "number" },
				{ id: "enabled", label: "Enabled", kind: "boolean", required: true },
				{
					id: "branch",
					label: "Branch",
					kind: "select",
					required: true,
					options: [
						{ value: "main", label: "Main" },
						{ value: "develop", label: "Develop" },
					],
				},
			],
		},
	};
}

function modelSchema(): LauncherModelConfigSchemaLike {
	return {
		availableProfiles: [
			{ id: "claude_fast", label: "Claude Fast", description: "fast" },
			{ id: "local_qwen", label: "Local Qwen", description: "local" },
		],
		llmTurns: [
			{ turnId: "draft_plan", description: "Draft plan" },
			{ turnId: "implement", description: "Implement" },
		],
	};
}

function modelEditSession() {
	const session = createLaunchSession({ launcher: launcher(), now: 0 });
	const schema = modelSchema();
	return { session, schema, first: beginLaunchModelEdit(session, schema) };
}

describe("Telegram launch sessions", () => {
	it("seeds launcher defaults and skips required fields that already have defaults", () => {
		const subject = launcher();
		const session = createLaunchSession({
			launcher: subject,
			defaults: { prompt: "default prompt", enabled: true, branch: "main" },
			now: 0,
		});

		expect(applyLaunchFieldText(session, subject, "/skip")).toMatchObject({ ok: true });
		expect(buildLaunchInput(session)).toMatchObject({ prompt: "default prompt" });
	});

	it("rejects skipping a required field without a default", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });

		const result = applyLaunchFieldText(session, subject, "/skip");

		expect(result.ok).toBe(false);
		expect(currentLaunchField(session, subject)?.id).toBe("prompt");
	});

	it("asks required fields before optional fields and collects typed values", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });

		expect(currentLaunchField(session, subject)?.id).toBe("prompt");
		expect(applyLaunchFieldText(session, subject, "write tests")).toMatchObject({ ok: true });
		expect(currentLaunchField(session, subject)?.id).toBe("enabled");
		expect(applyLaunchFieldText(session, subject, "yes")).toMatchObject({ ok: true });
		expect(currentLaunchField(session, subject)?.id).toBe("branch");
		expect(applyLaunchFieldText(session, subject, "2")).toMatchObject({ ok: true });
		expect(currentLaunchField(session, subject)?.id).toBe("count");
		const done = applyLaunchFieldText(session, subject, "3");

		expect(done).toEqual({
			ok: true,
			done: true,
			values: {
				prompt: "write tests",
				enabled: true,
				branch: "develop",
				count: 3,
			},
		});
	});

	it("accepts bot-qualified skip commands", () => {
		const subject = launcher();
		const session = createLaunchSession({
			launcher: subject,
			defaults: { prompt: "default prompt" },
			now: 0,
		});

		const result = applyLaunchFieldText(session, subject, "/skip@leitwerk_bot");

		expect(result).toMatchObject({ ok: true });
		expect(buildLaunchInput(session)).toMatchObject({ prompt: "default prompt" });
	});

	it("keeps the current field when number validation fails", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });
		session.fieldIndex = 3;

		const result = applyLaunchFieldText(session, subject, "not-a-number");

		expect(result.ok).toBe(false);
		expect(currentLaunchField(session, subject)?.id).toBe("count");
	});

	it("keeps the current field when select input does not match available options", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });
		session.fieldIndex = 2;

		const result = applyLaunchFieldText(session, subject, "missing-branch");

		expect(result.ok).toBe(false);
		expect(currentLaunchField(session, subject)?.id).toBe("branch");
	});

	it("uses dynamic select options ahead of schema options", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });
		session.fieldIndex = 2;
		const optionsById = {
			branch: [{ value: "release", label: "Release" }],
		};

		expect(getLaunchFieldOptions(subject.launchConfigSchema.fields[3], optionsById)).toEqual([
			{ value: "release", label: "Release" },
		]);
		const result = applyLaunchFieldText(session, subject, "Release", optionsById);

		expect(result).toMatchObject({ ok: true, done: false });
		expect(buildLaunchInput(session)).toMatchObject({ branch: "release" });
		expect(currentLaunchField(session, subject)?.id).toBe("count");
	});

	it("moves back to the field named by launcher validation", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });
		session.fieldIndex = subject.launchConfigSchema.fields.length;

		const field = moveLaunchSessionToValidationField(session, subject, [
			{ code: "invalid", message: "Branch is invalid", fieldId: "branch" },
		]);

		expect(field?.id).toBe("branch");
		expect(currentLaunchField(session, subject)?.id).toBe("branch");
	});

	it("edits launcher model defaults and turn overrides", () => {
		const { session, schema, first } = modelEditSession();

		expect(hasLaunchModelControls(schema)).toBe(true);
		expect(first).toMatchObject({ ok: true, done: false, step: { key: "default" } });
		expect(applyLaunchModelStepText(session, schema, "2")).toMatchObject({ ok: true });
		expect(currentLaunchModelStep(session, schema)?.key).toBe("turn:draft_plan");
		expect(
			applyLaunchModelStepAction(session, schema, { action: "set", value: "claude_fast" }),
		).toMatchObject({ ok: true });

		expect(buildLaunchModelConfig(session)).toEqual({
			defaultModelProfileId: "local_qwen",
			turnConfigs: { draft_plan: { modelProfileId: "claude_fast" } },
		});
		expect(session.modelConfigTouched).toBe(true);
	});

	it("handles model inherit, skip, invalid text, and prompts", () => {
		const { session, schema } = modelEditSession();
		session.modelConfig = { defaultModelProfileId: "claude_fast", turnConfigs: {} };

		expect(applyLaunchModelStepText(session, schema, "inherit")).toMatchObject({ ok: true });
		expect(buildLaunchModelConfig(session)).toEqual({
			defaultModelProfileId: null,
			turnConfigs: {},
		});
		expect(applyLaunchModelStepText(session, schema, "/skip")).toMatchObject({ ok: true });
		const result = applyLaunchModelStepText(session, schema, "unknown_profile");
		const step = currentLaunchModelStep(session, schema);

		expect(result.ok).toBe(false);
		expect(step?.key).toBe("turn:implement");
		if (step) {
			const turnDescription = schema.llmTurns.find(
				(turn) => turn.turnId === "implement",
			)?.description;
			expect(buildLaunchModelStepPrompt({ step, schema, session })).toContain(turnDescription);
		}
		expect(session.modelConfigTouched).toBe(true);
	});

	it("seeds model config from a prepared launch plan", () => {
		const subject = launcher();
		const session = createLaunchSession({ launcher: subject, now: 0 });

		seedLaunchModelConfigFromPlan(session, {
			launcherId: subject.id,
			processId: subject.processId,
			processInput: {
				processId: subject.processId,
				selectedTurnId: null,
				lifecycleStatus: "discovered",
				defaultModelProfileId: "claude_fast",
				turnConfigsJson: JSON.stringify({ implement: { modelProfileId: "local_qwen" } }),
				selectedTurnModelProfileId: null,
				paramsJson: "{}",
				stateJson: "{}",
			},
			projectInputs: [],
			startTurnId: null,
		});

		expect(buildLaunchModelConfig(session)).toEqual({
			defaultModelProfileId: "claude_fast",
			turnConfigs: { implement: { modelProfileId: "local_qwen" } },
		});
	});
});
