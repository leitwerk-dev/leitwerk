import { writable } from "svelte/store";

export interface KeyboardShortcutItem {
	keys: readonly string[];
	label: string;
}

export const keyboardShortcutHelpOpen = writable(false);

export function openKeyboardShortcutHelp(): void {
	keyboardShortcutHelpOpen.set(true);
}

export function closeKeyboardShortcutHelp(): void {
	keyboardShortcutHelpOpen.set(false);
}

export function toggleKeyboardShortcutHelp(): void {
	keyboardShortcutHelpOpen.update((open) => !open);
}
