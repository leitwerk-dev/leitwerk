import type { ServerExtensionEventMap } from "@leitwerk-dev/process-sdk";

/**
 * Server-side extension host. Mirrors the worker-side ProcessAPI.events pattern.
 * Extensions register handlers for lifecycle events. The server emits events
 * when IPC messages arrive or commands execute.
 */

export type ExtensionEventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export interface ExtensionHost<TEventMap extends object = ServerExtensionEventMap> {
	on<K extends keyof TEventMap & string>(
		event: K,
		handler: ExtensionEventHandler<TEventMap[K]>,
	): void;
	off<K extends keyof TEventMap & string>(
		event: K,
		handler: ExtensionEventHandler<TEventMap[K]>,
	): void;
	emit<K extends keyof TEventMap & string>(event: K, payload: TEventMap[K]): Promise<void>;
}

export function createExtensionHost<
	TEventMap extends object = ServerExtensionEventMap,
>(): ExtensionHost<TEventMap> {
	const handlers = new Map<string, Set<ExtensionEventHandler>>();

	return {
		on(event, handler) {
			let set = handlers.get(event);
			if (!set) {
				set = new Set();
				handlers.set(event, set);
			}
			set.add(handler as ExtensionEventHandler);
		},

		off(event, handler) {
			handlers.get(event)?.delete(handler as ExtensionEventHandler);
		},

		async emit(event, payload) {
			const set = handlers.get(event);
			if (!set) return;
			const errors: unknown[] = [];
			for (const handler of set) {
				try {
					await handler(payload);
				} catch (err) {
					errors.push(err);
				}
			}
			if (errors.length > 0) {
				throw errors[0];
			}
		},
	};
}
