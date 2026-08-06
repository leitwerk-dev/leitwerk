import type {
	ServerExtensionEventMap,
	ServerExtensionEventName,
	ServerExtensionEventPayloadInputMap,
} from "@leitwerk-dev/process-sdk";
import type { ExtensionHost } from "../../extensions/extension-host.js";

export type DeferredProcessExtensionEvent = {
	[K in ServerExtensionEventName]: {
		type: K;
		payload: ServerExtensionEventMap[K];
	};
}[ServerExtensionEventName];

export function createDeferredExtensionEvent<K extends ServerExtensionEventName>(
	instanceId: string,
	type: K,
	payload: ServerExtensionEventPayloadInputMap[K],
): DeferredProcessExtensionEvent {
	return {
		type,
		payload: {
			instanceId,
			...payload,
		} as ServerExtensionEventMap[K],
	} as DeferredProcessExtensionEvent;
}

export function emitDeferredExtensionEvent(
	host: ExtensionHost | undefined,
	event: DeferredProcessExtensionEvent,
): Promise<void> | void {
	return host?.emit(event.type, event.payload);
}
