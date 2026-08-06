// @vitest-environment jsdom

import { WS_PROCESS_TYPES, type WsFrame } from "@leitwerk-dev/protocol";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearPendingProcessToastFocus,
	pendingProcessToastFocusStore,
} from "./process-toast-focus.svelte.js";
import {
	dismissLatestToast,
	dismissToast,
	handleToastFrame,
	openToast,
	pushToast,
	toastStore,
} from "./toasts.svelte.js";

function resetToasts(): void {
	for (const toast of get(toastStore)) {
		dismissToast(toast.id);
	}
}

function toastFrame(dedupeKey: string): WsFrame {
	return {
		protocol: "leitwerk/ws/v1",
		type: WS_PROCESS_TYPES.TOAST,
		durability: "ephemeral",
		sentAt: new Date().toISOString(),
		instanceId: "agt_1",
		payload: {
			instanceId: "agt_1",
			level: "error",
			message: "Worker failed",
			eventType: "worker_failed",
			dedupeKey,
			ttlMs: 1000,
		},
	};
}

describe("toasts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetToasts();
	});

	afterEach(() => {
		resetToasts();
		clearPendingProcessToastFocus();
		window.history.replaceState(null, "", "/");
		vi.useRealTimers();
	});

	it("pushes and auto-dismisses toasts", () => {
		pushToast({
			instanceId: "agt_1",
			level: "error",
			message: "Worker failed",
			eventType: "worker_failed",
			dedupeKey: "dup-1",
			ttlMs: 1000,
		});

		expect(get(toastStore)).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		expect(get(toastStore)).toHaveLength(0);
	});

	it("deduplicates active toasts by dedupe key", () => {
		handleToastFrame(toastFrame("dup-1"));
		handleToastFrame(toastFrame("dup-1"));

		expect(get(toastStore)).toHaveLength(1);
	});

	it("keeps multiple distinct toasts visible at the same time", () => {
		handleToastFrame(toastFrame("dup-1"));
		handleToastFrame(toastFrame("dup-2"));

		expect(get(toastStore)).toHaveLength(2);
	});

	it("dismisses the latest toast first", () => {
		handleToastFrame(toastFrame("dup-1"));
		handleToastFrame(toastFrame("dup-2"));

		dismissLatestToast();

		const remainingToasts = get(toastStore);
		expect(remainingToasts).toHaveLength(1);
		expect(remainingToasts[0]?.dedupeKey).toBe("dup-1");
	});

	it("opens a toast by navigating to the process and queuing focus", () => {
		pushToast({
			instanceId: "agt_1",
			level: "warn",
			message: "Needs a decision",
			eventType: "action_required",
			dedupeKey: "dup-1",
			ttlMs: 1000,
		});

		const [toast] = get(toastStore);
		if (!toast) {
			throw new Error("Expected toast to exist");
		}
		openToast(toast.id);

		expect(window.location.pathname).toBe("/processes/agt_1");
		expect(get(pendingProcessToastFocusStore)).toMatchObject({
			instanceId: "agt_1",
			target: { kind: "action_required" },
		});
		expect(get(toastStore)).toHaveLength(0);
	});

	it("preserves a question-request target when opening a toast", () => {
		pushToast({
			instanceId: "agt_1",
			level: "warn",
			message: "Answers needed",
			eventType: "question_requested",
			dedupeKey: "question-1",
			ttlMs: 1000,
			focusTarget: { kind: "question_request", requestId: "qst_1" },
		});

		const toast = get(toastStore)[0];
		if (!toast) throw new Error("Expected toast to exist");
		openToast(toast.id);

		expect(get(pendingProcessToastFocusStore)).toMatchObject({
			instanceId: "agt_1",
			target: { kind: "question_request", requestId: "qst_1" },
		});
	});

	it("returns false for non-toast frames", () => {
		const result = handleToastFrame({
			protocol: "leitwerk/ws/v1",
			type: "process.updated",
			durability: "durable",
			sentAt: new Date().toISOString(),
			instanceId: "agt_1",
			payload: { process: { selectedTurnId: "generate_plan" }, changedFields: ["selectedTurnId"] },
		} as WsFrame);

		expect(result).toBe(false);
		expect(get(toastStore)).toHaveLength(0);
	});
});
