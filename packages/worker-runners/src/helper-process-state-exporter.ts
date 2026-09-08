import type { Readable } from "node:stream";
import type {
	ProcessStateExporter,
	ProcessStateExportHelperRelayProvider,
	ProcessVolume,
	VolumeRef,
} from "./types.js";

export interface ExportHelperLaunchInput {
	name: string;
	instanceId: string;
	exportId: string;
	credential: string;
	volume: VolumeRef;
	signal?: AbortSignal;
}

export interface ExportHelperUnit {
	wait(): Promise<{ exitCode: number | null; reason?: string }>;
	remove(): Promise<void>;
}

export function exportHelperEnvironment(input: {
	serverUrl: string;
	exportId: string;
	credential: string;
}): Record<string, string> {
	return {
		LEITWERK_EXPORT_SERVER_URL: input.serverUrl,
		LEITWERK_EXPORT_ID: input.exportId,
		LEITWERK_EXPORT_CREDENTIAL: input.credential,
	};
}

export function createHelperProcessStateExporter(input: {
	volume: Pick<ProcessVolume, "ensure">;
	helperRelays: ProcessStateExportHelperRelayProvider;
	launch(request: ExportHelperLaunchInput): Promise<ExportHelperUnit>;
	reconcileHelpers(): Promise<void>;
}): ProcessStateExporter {
	return {
		async prepare(request) {
			request.signal?.throwIfAborted();
			const volume = await input.volume.ensure(request.instanceId);
			request.signal?.throwIfAborted();
			const relay = input.helperRelays.create({
				instanceId: request.instanceId,
				manifest: request.manifest,
			});
			let removed = false;
			let removal: Promise<void> | null = null;
			let retryTimer: NodeJS.Timeout | null = null;
			let retryDelayMs = 250;
			let streamCompleted = false;
			let helper: ExportHelperUnit;
			try {
				helper = await input.launch({
					name: `leitwerk-export-${request.instanceId}-${relay.exportId}`,
					instanceId: request.instanceId,
					exportId: relay.exportId,
					credential: relay.credential,
					volume,
					signal: request.signal,
				});
			} catch (error) {
				relay.fail(error instanceof Error ? error : new Error("export_helper_launch_failed"));
				throw error;
			}
			const remove = async (): Promise<void> => {
				if (removed || retryTimer) return;
				if (removal) return removal;
				removal = Promise.resolve()
					.then(() => helper.remove())
					.then(
						() => {
							removed = true;
						},
						() => {
							// Keep cleanup owned until the runner confirms removal. A transient
							// API failure must not escape an abort or stream event handler.
							retryTimer = setTimeout(() => {
								retryTimer = null;
								void remove();
							}, retryDelayMs);
							retryTimer.unref();
							retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
						},
					)
					.finally(() => {
						removal = null;
					});
				return removal;
			};
			const onAbort = (): void => {
				relay.fail(new Error("session_transfer_cancelled"));
				void remove();
			};
			request.signal?.addEventListener("abort", onAbort, { once: true });
			const exited = helper.wait().then(
				(exit) => {
					if (!removed && (!streamCompleted || exit.exitCode !== 0)) {
						relay.fail(new Error(exit.reason ?? "export_helper_failed"));
					}
					return exit;
				},
				(error: unknown) => {
					relay.fail(error instanceof Error ? error : new Error("export_helper_wait_failed"));
					return { exitCode: null, reason: "export_helper_wait_failed" };
				},
			);
			try {
				request.signal?.throwIfAborted();
				const report = await relay.waitForPreflight(request.signal);
				request.signal?.throwIfAborted();
				return {
					...report,
					stream(): Readable {
						const stream = relay.activateStream();
						let cleanupRequested = false;
						const cleanup = (error?: Error): void => {
							if (cleanupRequested) return;
							cleanupRequested = true;
							if (!streamCompleted && error) relay.fail(error);
							request.signal?.removeEventListener("abort", onAbort);
							if (streamCompleted) void exited.then(remove);
							else void remove();
						};
						stream.once("end", () => {
							streamCompleted = true;
							cleanup();
						});
						stream.once("error", (error: Error) => cleanup(error));
						stream.once("close", () => {
							if (!streamCompleted) relay.fail(new Error("session_transfer_stream_closed"));
							cleanup();
						});
						return stream;
					},
				};
			} catch (error) {
				request.signal?.removeEventListener("abort", onAbort);
				relay.fail(error instanceof Error ? error : new Error("session_transfer_failed"));
				await remove();
				throw error;
			}
		},
		reconcile: input.reconcileHelpers,
	};
}
