import type { DashboardResponseBody } from "@leitwerk-dev/protocol/http-contracts";

/** Snapshot state retained across refresh failures. @internal */
export interface DashboardLoadState {
	data: DashboardResponseBody | null;
	loading: boolean;
	error: string | null;
}

/** Coalesces refresh triggers and invalidates responses after disposal. @internal */
export function createDashboardRefresh(
	fetchSnapshot: (signal: AbortSignal) => Promise<DashboardResponseBody>,
	publish: (state: DashboardLoadState) => void,
) {
	let state: DashboardLoadState = { data: null, loading: false, error: null };
	let active: Promise<void> | null = null;
	let disposed = false;
	let controller: AbortController | null = null;
	return {
		refresh(): Promise<void> {
			if (disposed) return Promise.resolve();
			if (active) return active;
			controller = new AbortController();
			const signal = controller.signal;
			state = { ...state, loading: true, error: null };
			publish(state);
			active = Promise.resolve()
				.then(() => fetchSnapshot(signal))
				.then(
					(data) => {
						if (!disposed) state = { data, loading: false, error: null };
					},
					() => {
						if (!disposed)
							state = {
								...state,
								loading: false,
								error: "Couldn't refresh the dashboard. Try again.",
							};
					},
				)
				.finally(() => {
					active = null;
					if (!disposed) publish(state);
				});
			return active;
		},
		dispose() {
			disposed = true;
			controller?.abort();
		},
	};
}
