import { get } from "svelte/store";
import { keyboardShortcutHelpOpen } from "./keyboard-shortcuts-help.js";

export function isTextEntryTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}

	if (target.isContentEditable) {
		return true;
	}

	const tagName = target.tagName.toLowerCase();
	return tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function isPlainShortcut(event: KeyboardEvent): boolean {
	return !event.metaKey && !event.ctrlKey && !event.altKey;
}

export function shouldIgnorePlainShortcut(event: KeyboardEvent): boolean {
	return (
		event.defaultPrevented ||
		get(keyboardShortcutHelpOpen) ||
		isTextEntryTarget(event.target) ||
		!isPlainShortcut(event)
	);
}

/**
 * True when the event target is an interactive control that has its own native
 * activation (button, link, summary, or an explicit button role). Window-level
 * key shortcuts must not steal keys like Enter/Space from these elements.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return target.closest('button, a[href], summary, [role="button"]') !== null;
}
