/** @internal Focus a newly opened note without moving the canvas. */
export function focusNote(element: HTMLTextAreaElement) {
	element.focus({ preventScroll: true });
}

/** @internal Close notes on outside clicks or Cmd/Ctrl+Enter; edits already autosave. */
export function dismissNote(element: HTMLElement, options: { open: boolean; close: () => void }) {
	let current = options;
	const outside = (event: PointerEvent) => {
		if (!current.open || !(event.target instanceof Element)) return;
		if (element.querySelector("[data-note-editor]")?.contains(event.target)) return;
		const toggle = event.target.closest("[data-note-toggle]");
		if (toggle && element.contains(toggle)) return;
		current.close();
	};
	const keyboard = (event: KeyboardEvent) => {
		if (!current.open || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		event.stopPropagation();
		current.close();
		queueMicrotask(() =>
			element
				.querySelector<HTMLButtonElement>("[data-note-toggle]")
				?.focus({ preventScroll: true }),
		);
	};
	document.addEventListener("pointerdown", outside, true);
	element.addEventListener("keydown", keyboard, true);
	return {
		update(next: typeof options) {
			current = next;
		},
		destroy() {
			document.removeEventListener("pointerdown", outside, true);
			element.removeEventListener("keydown", keyboard, true);
		},
	};
}
