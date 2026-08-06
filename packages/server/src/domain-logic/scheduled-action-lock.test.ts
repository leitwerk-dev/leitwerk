import { describe, expect, it } from "vitest";
import {
	evaluateScheduledActionLock,
	isQueuedInputBlockedByScheduledAction,
	queuedInputsRequireScheduledActionLockBypass,
} from "./scheduled-action-lock.js";

describe("scheduled action lock logic", () => {
	it("allows queued system inputs while a scheduled action is pending", () => {
		expect(queuedInputsRequireScheduledActionLockBypass([{ source: "system" }])).toBe(false);
		expect(
			isQueuedInputBlockedByScheduledAction({
				scheduledAction: { id: "fut_1" },
				queuedInputs: [{ source: "system" }],
			}),
		).toBe(false);
	});

	it("blocks non-system queued inputs while a scheduled action is pending", () => {
		expect(queuedInputsRequireScheduledActionLockBypass([{ source: "app_steer" }])).toBe(true);
		expect(
			isQueuedInputBlockedByScheduledAction({
				scheduledAction: { id: "fut_1" },
				queuedInputs: [{ source: "system" }, { source: "app_steer" }],
			}),
		).toBe(true);
	});

	it("allows ordinary actions when no scheduled action is pending", () => {
		expect(
			evaluateScheduledActionLock({
				scheduledAction: null,
				actionSource: "ui",
			}),
		).toEqual({ ok: true });
	});

	it("blocks ordinary actions that do not target the pending scheduled action", () => {
		expect(
			evaluateScheduledActionLock({
				scheduledAction: { id: "fut_1" },
				actionSource: "ui",
			}),
		).toMatchObject({ ok: false, code: "action_locked_by_schedule" });
	});

	it("allows explicit execute-now requests for the current scheduled action", () => {
		expect(
			evaluateScheduledActionLock({
				scheduledAction: { id: "fut_1" },
				actionSource: "ui",
				scheduledExecutionId: "fut_1",
			}),
		).toEqual({ ok: true });
	});

	it("allows scheduled dispatch only for the current scheduled action", () => {
		expect(
			evaluateScheduledActionLock({
				scheduledAction: { id: "fut_1" },
				actionSource: "scheduled",
				scheduledExecutionId: "fut_1",
			}),
		).toEqual({ ok: true });
		expect(
			evaluateScheduledActionLock({
				scheduledAction: { id: "fut_1" },
				actionSource: "scheduled",
				scheduledExecutionId: "fut_2",
			}),
		).toMatchObject({ ok: false, code: "scheduled_action_missing" });
	});

	it("rejects scheduled dispatch after cancellation", () => {
		expect(
			evaluateScheduledActionLock({
				scheduledAction: null,
				actionSource: "scheduled",
				scheduledExecutionId: "fut_1",
			}),
		).toMatchObject({ ok: false, code: "scheduled_action_missing" });
	});
});
