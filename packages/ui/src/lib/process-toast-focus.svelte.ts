import type { ProcessAttentionTarget } from "@leitwerk-dev/protocol";
import { writable } from "svelte/store";

export interface PendingProcessToastFocus {
	instanceId: string;
	target: ProcessAttentionTarget;
	queuedAt: string;
}

export const pendingProcessToastFocusStore = writable<PendingProcessToastFocus | null>(null);

export function queuePendingProcessToastFocus(focus: PendingProcessToastFocus | null): void {
	pendingProcessToastFocusStore.set(focus);
}

export function clearPendingProcessToastFocus(): void {
	pendingProcessToastFocusStore.set(null);
}
