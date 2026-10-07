import type { StubToolCallScriptItem, StubToolCallScriptResolver } from "./stub-pi-tree-handle.js";

/** @internal */
export interface StubToolScriptController {
	/** @internal */
	readonly resolver: StubToolCallScriptResolver;
	/** @internal */
	set(script: StubToolCallScriptItem[]): void;
}

/** @internal */
export function createStubToolScriptController(): StubToolScriptController {
	const queue: StubToolCallScriptItem[] = [];
	return {
		resolver: () => queue.shift(),
		set(script) {
			queue.splice(0, queue.length, ...script);
		},
	};
}
