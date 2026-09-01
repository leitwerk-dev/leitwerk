import type { WorkerExitInfo, WorkerUnit, WorkerUnitRef } from "./types.js";

/**
 * Shared exit-notification machinery used by every {@link WorkerRunner}.
 *
 * Each runner implementation tracks physical unit exits and maps them to
 * `WorkerUnit.onExit` callbacks. This utility captures the identical map +
 * fire/wrap logic and leaves only the unit-keying to each runner.
 */
export class UnitExitNotifier {
	private readonly listeners = new Map<string, Array<(info: WorkerExitInfo) => void>>();
	private readonly exited = new Map<string, WorkerExitInfo>();

	onExit(key: string, listener: (info: WorkerExitInfo) => void): void {
		const exit = this.exited.get(key);
		if (exit) {
			queueMicrotask(() => listener(exit));
			return;
		}
		const list = this.listeners.get(key) ?? [];
		list.push(listener);
		this.listeners.set(key, list);
	}

	fireExit(key: string, info: WorkerExitInfo): void {
		if (this.exited.has(key)) return;
		this.exited.set(key, info);
		const list = this.listeners.get(key);
		if (!list) return;
		this.listeners.delete(key);
		for (const listener of list.splice(0)) listener(info);
	}

	wrapUnit<T extends WorkerUnitRef>(
		ref: T,
		key: string,
		options?: { replacementHandoff?: WorkerUnit["replacementHandoff"] },
	): WorkerUnit {
		return {
			...ref,
			...(options?.replacementHandoff ? { replacementHandoff: options.replacementHandoff } : {}),
			onExit: (listener) => this.onExit(key, listener),
		};
	}
}
