import { vi } from "vitest";

/** Drain pending microtasks and yield once to the UI. @internal */
export async function flushUi() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** @internal */
export function waitForSelector(target: HTMLElement, selector: string, timeoutMs = 250) {
	return vi.waitFor(
		() => {
			const element = target.querySelector(selector);
			if (!(element instanceof HTMLElement))
				throw new Error(`Timed out waiting for selector: ${selector}`);
			return element;
		},
		{ timeout: timeoutMs, interval: 1 },
	);
}
