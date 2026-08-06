import type { EventBus } from "./types.js";

export function createEventBus<
	TEventMap extends object = Record<string, unknown>,
>(): EventBus<TEventMap> {
	const listeners = new Map<string, Set<(data: unknown) => void | Promise<void>>>();

	return {
		emit(event, data) {
			const handlers = listeners.get(event);
			if (!handlers) return;
			for (const handler of handlers) {
				try {
					void handler(data);
				} catch {
					// swallow handler errors to avoid breaking the emit loop
				}
			}
		},

		on(event, handler) {
			const typedHandler = handler as unknown as (data: unknown) => void | Promise<void>;
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(typedHandler);
		},

		off(event, handler) {
			listeners.get(event)?.delete(handler as unknown as (data: unknown) => void | Promise<void>);
		},
	};
}
