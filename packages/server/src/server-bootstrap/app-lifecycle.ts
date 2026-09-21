import type { FastifyInstance } from "fastify";
import type { ServerListenOptions, ServerListenResult } from "../app.js";
import type { LeitwerkConfig } from "../config/index.js";

type LifecycleHook = () => void | Promise<void>;

/** @internal */
export async function collectCleanupErrors(operations: Array<() => void | Promise<void>>) {
	const errors: unknown[] = [];
	for (const operation of [...operations].reverse()) {
		try {
			await operation();
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

/** Coordinates one context's listener, startup and shutdown. @internal */
export function createAppLifecycle(input: {
	app: FastifyInstance;
	server: LeitwerkConfig["server"];
	authEnabled: boolean;
	reconcile(assertOpen: () => void): Promise<void>;
	startHooks: readonly LifecycleHook[];
	preCloseCleanup: LifecycleHook[];
	closeDatabase: LifecycleHook;
}) {
	const { app } = input;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	let startupOperation: Promise<void> | undefined;
	let startupPromise: Promise<void> | undefined;
	let binding: Required<ServerListenOptions> | undefined;
	let bindOperation: Promise<ServerListenResult> | undefined;
	const cleanupErrors: unknown[] = [];
	function assertOpen() {
		if (closing) throw new Error("AppContext startup interrupted: context is closed");
	}
	function close(): Promise<void> {
		closing = true;
		backgroundServicesReady = false;
		closePromise ??= (async () => {
			await bindOperation?.catch(() => {});
			await startupOperation?.catch(() => {});
			await app.close();
		})();
		return closePromise;
	}
	async function failStartup(error: unknown): Promise<never> {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Server startup failed and cleanup failed", {
				cause: error,
			});
		}
		throw error;
	}
	async function listen(options: ServerListenOptions = {}): Promise<ServerListenResult> {
		assertOpen();
		if (binding) {
			for (const key of ["host", "port", "useBoundAddressAsBaseUrl"] as const) {
				if (options[key] !== undefined && options[key] !== binding[key])
					throw new Error(`Conflicting listener option: ${key}`);
			}
		} else {
			if (app.server.listening) throw new Error("Cannot adopt a manually bound listener");
			const requested = {
				host: options.host ?? input.server.host,
				port: options.port ?? input.server.port,
				useBoundAddressAsBaseUrl: options.useBoundAddressAsBaseUrl ?? false,
			};
			if (
				requested.useBoundAddressAsBaseUrl &&
				(input.authEnabled || !["127.0.0.1", "::1", "localhost"].includes(requested.host))
			)
				throw new Error("Bound base URL requires an unauthenticated loopback listener");
			binding = requested;
			bindOperation = (async () => {
				const started = performance.now();
				const address = await app.listen({ host: requested.host, port: requested.port });
				app.log.info(
					{ listenDurationMs: Math.round((performance.now() - started) * 10) / 10 },
					"Server HTTP listener ready",
				);
				const info = app.server.address();
				if (!info || typeof info === "string") throw new Error("Expected TCP listener address");
				if (requested.useBoundAddressAsBaseUrl) input.server.base_url = address;
				return { address, port: info.port };
			})();
		}
		let result: ServerListenResult;
		try {
			if (!bindOperation) throw new Error("Listener was not initialized");
			result = await bindOperation;
		} catch (error) {
			return failStartup(error);
		}
		await startServices();
		assertOpen();
		return result;
	}
	function startServices(): Promise<void> {
		if (closing)
			return Promise.reject(new Error("AppContext startup interrupted: context is closed"));
		if (startupPromise) return startupPromise;
		startupOperation = (async () => {
			await bindOperation;
			assertOpen();
			await input.reconcile(assertOpen);
			for (const hook of input.startHooks) {
				assertOpen();
				await hook();
			}
			assertOpen();
			backgroundServicesReady = true;
		})();
		// Cleanup waits on the raw operation, not this promise that itself awaits close().
		startupPromise = startupOperation.catch(failStartup);
		return startupPromise;
	}
	let backgroundServicesReady = false;
	let cleanupOperation: Promise<void> | undefined;
	function cleanup() {
		closing = true;
		backgroundServicesReady = false;
		cleanupOperation ??= (async () => {
			await startupOperation?.catch(() => {});
			// Stop services and workers before connection teardown; retain SQLite for onClose.
			cleanupErrors.push(...(await collectCleanupErrors(input.preCloseCleanup.splice(0))));
		})();
		return cleanupOperation;
	}
	app.addHook("preClose", cleanup);
	async function finishCleanup() {
		await cleanup();
		cleanupErrors.push(...(await collectCleanupErrors([input.closeDatabase])));
		if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "AppContext cleanup failed");
	}

	return {
		listen,
		close,
		isReady: () => backgroundServicesReady,
		isClosing: () => closing,
		finishCleanup,
	};
}
