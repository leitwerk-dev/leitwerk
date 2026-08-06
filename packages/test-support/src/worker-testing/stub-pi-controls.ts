import type { StubToolCallScriptItem, StubToolCallScriptResolver } from "./stub-pi-tree-handle.js";

export interface StubToolScriptController {
	readonly resolver: StubToolCallScriptResolver;
	set(script: StubToolCallScriptItem[]): void;
}

export function createStubToolScriptController(): StubToolScriptController {
	const queue: StubToolCallScriptItem[] = [];
	return {
		resolver: () => queue.shift(),
		set(script) {
			queue.splice(0, queue.length, ...script);
		},
	};
}
