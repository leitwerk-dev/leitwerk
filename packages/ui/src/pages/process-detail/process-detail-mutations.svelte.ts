export type ProcessDetailMutationKey =
	| `action:${string}`
	| `continue:${string}`
	| "retry"
	| "retry-startup"
	| "abort-turn"
	| "cancel-scheduled-action";

export function createProcessDetailMutations() {
	let activeMutationKey = $state<ProcessDetailMutationKey | null>(null);
	let mutationErrors = $state<Partial<Record<ProcessDetailMutationKey, string>>>({});

	function isBusy(key: ProcessDetailMutationKey): boolean {
		return activeMutationKey === key;
	}

	function isAnyBusy(): boolean {
		return activeMutationKey !== null;
	}

	function errorFor(key: ProcessDetailMutationKey): string | null {
		return mutationErrors[key] ?? null;
	}

	function clearErrors(keys?: readonly ProcessDetailMutationKey[]) {
		if (!keys) {
			mutationErrors = {};
			return;
		}
		let next = mutationErrors;
		for (const key of keys) {
			if (!next[key]) {
				continue;
			}
			next = { ...next };
			delete next[key];
		}
		mutationErrors = next;
	}

	function setError(key: ProcessDetailMutationKey, message: string) {
		mutationErrors = {
			...mutationErrors,
			[key]: message,
		};
	}

	async function runMutation(
		key: ProcessDetailMutationKey,
		operation: () => Promise<void>,
		options: {
			fallbackErrorMessage: string;
			clearErrorKeys?: readonly ProcessDetailMutationKey[];
		} = { fallbackErrorMessage: "Action failed" },
	): Promise<void> {
		if (activeMutationKey !== null) {
			return;
		}
		activeMutationKey = key;
		clearErrors([key, ...(options.clearErrorKeys ?? [])]);
		try {
			await operation();
		} catch (error) {
			setError(key, error instanceof Error ? error.message : options.fallbackErrorMessage);
		} finally {
			if (activeMutationKey === key) {
				activeMutationKey = null;
			}
		}
	}

	function reset() {
		activeMutationKey = null;
		mutationErrors = {};
	}

	return {
		get activeMutationKey() {
			return activeMutationKey;
		},
		get mutationErrors() {
			return mutationErrors;
		},
		isBusy,
		isAnyBusy,
		errorFor,
		clearErrors,
		runMutation,
		reset,
	};
}
