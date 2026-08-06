import { describe, expect, it } from "vitest";
import {
	applyFormSkip,
	applyFormText,
	buildActionFormSession,
	buildActionModelSession,
	buildActionModelSwitchWarning,
	buildFieldPrompt,
	canSkipActionFormField,
	currentField,
} from "./form-session.js";

const form = {
	id: "decision",
	title: "Decision",
	fields: [
		{ id: "message", label: "Message", kind: "textarea" as const, required: true },
		{ id: "count", label: "Count", kind: "number" as const },
		{ id: "confirm", label: "Confirm", kind: "boolean" as const, required: true },
	],
};

describe("Telegram form sessions", () => {
	it("prompts for the current field", () => {
		const session = buildActionFormSession({
			instanceId: "agt",
			actionId: "act",
			sessionId: "session_1",
			form,
		});
		const field = currentField(session);
		expect(field?.id).toBe("message");
		expect(field ? buildFieldPrompt(field) : "").toContain(field?.label);
	});

	it("collects typed values across fields", () => {
		const session = buildActionFormSession({
			instanceId: "agt",
			actionId: "act",
			sessionId: "session_2",
			form,
		});
		expect(applyFormText(session, "hello")).toMatchObject({ ok: true, done: false });
		expect(applyFormText(session, "42")).toMatchObject({ ok: true, done: false });
		const done = applyFormText(session, "yes");
		expect(done).toEqual({
			ok: true,
			done: true,
			values: { message: "hello", count: 42, confirm: true },
		});
	});

	it("keeps the current field when validation fails", () => {
		const session = buildActionFormSession({
			instanceId: "agt",
			actionId: "act",
			sessionId: "session_3",
			form,
		});
		const result = applyFormText(session, "");
		expect(result.ok).toBe(false);
		expect(currentField(session)?.id).toBe("message");
	});

	it("includes optional field metadata in prompts", () => {
		const field = {
			id: "tailLines",
			label: "SENTINEL_FIELD_LABEL",
			kind: "number" as const,
			placeholder: "SENTINEL_FIELD_PLACEHOLDER",
			description: "SENTINEL_FIELD_DESCRIPTION",
		};
		const prompt = buildFieldPrompt(field);

		expect(prompt).toContain(field.label);
		expect(prompt).toContain(field.placeholder);
		expect(prompt).toContain(field.description);
	});

	it("skips optional fields without submitting empty values", () => {
		const session = buildActionFormSession({
			instanceId: "agt",
			actionId: "act",
			sessionId: "session_skip",
			form,
		});
		expect(applyFormText(session, "hello")).toMatchObject({ ok: true, done: false });
		expect(applyFormSkip(session)).toMatchObject({ ok: true, done: false });
		const done = applyFormText(session, "yes");
		expect(done).toEqual({
			ok: true,
			done: true,
			values: { message: "hello", confirm: true },
		});
	});

	it("rejects skipping required fields", () => {
		const session = buildActionFormSession({
			instanceId: "agt",
			actionId: "act",
			sessionId: "session_required_skip",
			form,
		});

		expect(applyFormSkip(session)).toMatchObject({ ok: false });
		expect(currentField(session)?.id).toBe("message");
	});

	it("warns only when a warm continuation changes the underlying model", () => {
		const session = buildActionModelSession({
			instanceId: "agt",
			actionId: "continue",
			actionLabel: "Continue",
			sessionId: "session_model",
			formValues: {},
			profiles: [
				{
					id: "claude",
					label: "Claude",
					description: "Claude",
					availability: "available",
				},
			],
			preview: {
				kind: "llm_turn",
				turnId: "continue",
				description: "Continue",
				resolvedModel: {
					status: "resolved",
					modelProfileId: "gpt",
					source: "instance_default",
					error: null,
				},
				warmPromptCache: {
					previousModelProfileId: "claude",
					compatibleModelProfileIds: ["claude", "claude-thinking"],
					expiresAt: "2026-01-01T00:31:00.000Z",
				},
			},
		});

		expect(
			buildActionModelSwitchWarning({
				session,
				effectiveModelProfileId: "gpt",
				now: Date.parse("2026-01-01T00:30:00.000Z"),
			}),
		).toContain(session.profiles[0]?.label);
		expect(
			buildActionModelSwitchWarning({
				session,
				effectiveModelProfileId: "claude-thinking",
				now: Date.parse("2026-01-01T00:30:00.000Z"),
			}),
		).toBeNull();
		expect(
			buildActionModelSwitchWarning({
				session,
				effectiveModelProfileId: "gpt",
				now: Date.parse("2026-01-01T00:31:00.001Z"),
			}),
		).toBeNull();
	});

	it("warns without recommending a Telegram-filtered compatible profile", () => {
		const session = buildActionModelSession({
			instanceId: "agt",
			actionId: "continue",
			actionLabel: "Continue",
			sessionId: "session_filtered",
			formValues: {},
			profiles: [{ id: "gpt", label: "GPT", description: "GPT", availability: "available" }],
			preview: {
				kind: "llm_turn",
				turnId: "continue",
				description: "Continue",
				warmPromptCache: {
					previousModelProfileId: "claude",
					compatibleModelProfileIds: ["claude"],
					expiresAt: "2026-01-01T00:31:00.000Z",
				},
			},
		});
		expect(
			buildActionModelSwitchWarning({
				session,
				effectiveModelProfileId: "gpt",
				now: Date.parse("2026-01-01T00:30:00.000Z"),
			}),
		).toContain("No equivalent selectable profile");
	});

	it("marks optional fields as skippable", () => {
		expect(canSkipActionFormField({ id: "m", label: "Message", kind: "textarea" })).toBe(true);
		expect(canSkipActionFormField({ id: "n", label: "Count", kind: "number" })).toBe(true);
		expect(canSkipActionFormField({ id: "b", label: "Confirm", kind: "boolean" })).toBe(true);
		expect(
			canSkipActionFormField({ id: "m", label: "Message", kind: "text", required: true }),
		).toBe(false);
	});
});
