import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { PiTreeHandleFactory } from "@leitwerk-dev/worker";
import { createWorkerEntryRuntime } from "@leitwerk-dev/worker";
import { createSchemaDrivenStubPiFactory } from "./schema-driven-stub-pi.js";
import type { StubToolCallScriptResolver } from "./stub-pi-tree-handle.js";

const require = createRequire(import.meta.url);
const WebSocket =
	(require("ws") as { WebSocket?: unknown; default?: unknown }).WebSocket ??
	(require("ws") as { default?: unknown }).default ??
	require("ws");

export interface InProcessWorkerSpawnOptions {
	extensionCatalog?: ExtensionCatalog | Promise<ExtensionCatalog>;
	piFactory?: PiTreeHandleFactory;
	toolCallScriptResolver?: StubToolCallScriptResolver;
	/** Optional delays at real connection and managed-runtime preparation boundaries. */
	startupDelays?: (instanceId: string) => { connectMs: number; prepareMs: number } | undefined;
}

/**
 * Fast local-runner-shaped spawn fake. The worker receives the local runner's
 * env and connects over WebSocket just like Docker/Kubernetes workers do.
 */
export function createInProcessWorkerSpawn(
	options: InProcessWorkerSpawnOptions = {},
): typeof spawn {
	const piFactory =
		options.piFactory ??
		createSchemaDrivenStubPiFactory({
			toolCallScriptResolver: options.toolCallScriptResolver,
		});
	return ((
		command: string,
		args: readonly string[] = [],
		spawnOptions?: { env?: NodeJS.ProcessEnv },
	) => {
		const stderr = new PassThrough();
		const child = new EventEmitter() as unknown as ChildProcess;
		const emitter = child as unknown as EventEmitter;
		let exited = false;
		const cancellation = new AbortController();
		const timing = options.startupDelays?.(spawnOptions?.env?.LEITWERK_INSTANCE_ID ?? "");
		const pause = (ms: number) => delay(ms, undefined, { signal: cancellation.signal });

		let runtime: ReturnType<typeof createWorkerEntryRuntime> | null = null;
		const finish = (code: number) => {
			if (!exited) {
				exited = true;
				cancellation.abort();
				emitter.emit("exit", code, null);
			}
		};

		Object.assign(child, {
			stderr,
			pid: Math.floor(Math.random() * 100_000) + 1_000,
			kill: (_signal?: NodeJS.Signals | number) => {
				finish(0);
				void runtime?.stop("test_kill").catch(() => {});
				return true;
			},
			spawnfile: command,
			spawnargs: [command, ...args],
		});

		runtime = createWorkerEntryRuntime({
			extensionCatalog: options.extensionCatalog,
			piFactory: timing
				? {
						async prepareManagedBootstrap(input) {
							await pause(timing.prepareMs);
							return piFactory.prepareManagedBootstrap(input);
						},
						inspectPrimaryTree: (input) => piFactory.inspectPrimaryTree(input),
						createPrimaryTreeHandle: (input) => piFactory.createPrimaryTreeHandle(input),
					}
				: piFactory,
			stderr,
			env: spawnOptions?.env ?? process.env,
			exit: finish,
		});

		setImmediate(() => {
			if (exited) return;
			(globalThis as unknown as { WebSocket?: unknown }).WebSocket = WebSocket;
			void (async () => {
				if (timing) await pause(timing.connectMs);
				if (!exited) await runtime?.start();
			})().catch((error: unknown) => {
				if (exited) return;
				stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				finish(1);
			});
		});

		return child;
	}) as typeof spawn;
}
