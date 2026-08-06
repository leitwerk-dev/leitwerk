import {
	type ProcessAttentionTarget,
	WS_PROCESS_TYPES,
	type WsFrame,
	type WsPayloadByType,
} from "@leitwerk-dev/protocol";
import { get, writable } from "svelte/store";
import { queuePendingProcessToastFocus } from "./process-toast-focus.svelte.js";
import { buildProcessPath, navigate } from "./router.svelte.js";

export type ToastItem = WsPayloadByType[typeof WS_PROCESS_TYPES.TOAST] & {
	id: string;
	createdAt: string;
};

const FALLBACK_TOAST_TTL_MS = 6_000;

export const toastStore = writable<ToastItem[]>([]);

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function nextToastId(): string {
	return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clearToastTimer(id: string) {
	const timer = toastTimers.get(id);
	if (!timer) {
		return;
	}
	clearTimeout(timer);
	toastTimers.delete(id);
}

export function dismissToast(id: string): void {
	clearToastTimer(id);
	toastStore.update((items) => items.filter((toast) => toast.id !== id));
}

export function resolveToastFocusTarget(eventType: string): ProcessAttentionTarget | null {
	switch (eventType) {
		case "action_required":
		case "turn_failed":
		case "worker_failed":
			return { kind: eventType };
		default:
			return null;
	}
}

export function openToast(id: string): void {
	const toast = get(toastStore).find((item) => item.id === id);
	if (!toast) {
		return;
	}
	const target = toast.focusTarget ?? resolveToastFocusTarget(toast.eventType);
	if (target) {
		queuePendingProcessToastFocus({
			instanceId: toast.instanceId,
			target,
			queuedAt: new Date().toISOString(),
		});
	}
	navigate(buildProcessPath(toast.instanceId));
	dismissToast(id);
}

export function dismissLatestToast(): void {
	const latestToast = get(toastStore).at(-1);
	if (!latestToast) {
		return;
	}
	dismissToast(latestToast.id);
}

export function pushToast(
	payload: WsPayloadByType[typeof WS_PROCESS_TYPES.TOAST],
	ttlMs = Number.isFinite(payload.ttlMs) ? Math.max(0, payload.ttlMs) : FALLBACK_TOAST_TTL_MS,
): void {
	if (get(toastStore).some((toast) => toast.dedupeKey === payload.dedupeKey)) {
		return;
	}

	const item: ToastItem = {
		id: nextToastId(),
		createdAt: new Date().toISOString(),
		...payload,
	};
	toastStore.update((items) => [...items, item]);
	toastTimers.set(
		item.id,
		setTimeout(() => {
			dismissToast(item.id);
		}, ttlMs),
	);
}

export function handleToastFrame(frame: WsFrame): boolean {
	if (frame.type !== WS_PROCESS_TYPES.TOAST) {
		return false;
	}
	pushToast(frame.payload);
	return true;
}
