// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingProcessToastFocus } from "../lib/process-toast-focus.svelte.js";
import { dismissToast, pushToast, toastStore } from "../lib/toasts.svelte.js";
import ToastContainer from "./ToastContainer.svelte";

function mountSubject() {
	const target = document.createElement("div");
	document.body.appendChild(target);
	const app = mount(ToastContainer, { target });
	return { app, target };
}

function resetToasts(): void {
	for (const toast of get(toastStore)) {
		dismissToast(toast.id);
	}
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("ToastContainer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetToasts();
		clearPendingProcessToastFocus();
		window.history.replaceState(null, "", "/");
	});

	afterEach(() => {
		resetToasts();
		clearPendingProcessToastFocus();
		document.body.innerHTML = "";
		window.history.replaceState(null, "", "/");
		vi.useRealTimers();
	});

	it("renders an open affordance for actionable toasts", async () => {
		const { app, target } = mountSubject();
		pushToast({
			instanceId: "agt_1",
			level: "warn",
			message: "Review implementation needs a decision",
			eventType: "action_required",
			dedupeKey: "dup-1",
			ttlMs: 1000,
		});
		await flush();

		const openButton = target.querySelector<HTMLButtonElement>(".toast-open");
		expect(openButton).toBeTruthy();
		expect(openButton?.textContent).toContain("Action required");
		expect(openButton?.textContent).toContain("Review implementation needs a decision");

		unmount(app);
	});

	it("dismisses the newest toast when Escape is pressed", async () => {
		const { app } = mountSubject();
		pushToast({
			instanceId: "agt_1",
			level: "warn",
			message: "First",
			eventType: "action_required",
			dedupeKey: "dup-1",
			ttlMs: 1000,
		});
		pushToast({
			instanceId: "agt_2",
			level: "error",
			message: "Second",
			eventType: "turn_failed",
			dedupeKey: "dup-2",
			ttlMs: 1000,
		});
		await flush();

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await flush();

		expect(get(toastStore)).toHaveLength(1);
		expect(get(toastStore)[0]?.message).toBe("First");

		unmount(app);
	});
});
