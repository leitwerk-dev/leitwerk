import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LeitwerkConfig } from "@leitwerk-dev/server";
import { sandboxConfig } from "./config.js";
import { createSandboxApp, type SandboxCompositionFactory, type SandboxInput } from "./index.js";

/** @public */
export interface SandboxHarnessOptions {
	/** Adjust the generated configuration before the first start. @public */
	configure?(config: LeitwerkConfig): void;
}

/** @public */
export interface SandboxScenarioResponse {
	/** @public */
	statusCode: number;
	/** @public */
	body: Record<string, unknown>;
}

/**
 * Start a scripted sandbox composition on an ephemeral loopback port with disposable
 * storage. `stop()` closes the application and removes the storage.
 * @public
 */
export async function startSandboxHarness(
	factory: SandboxCompositionFactory,
	options: SandboxHarnessOptions = {},
) {
	const root = mkdtempSync(path.join(tmpdir(), "leitwerk-sandbox-"));
	const input: SandboxInput = {
		paths: { workspaceRoot: root, root, directory: root },
		mode: "scripted",
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:19173" },
		modelProfileId: "sandbox",
	};
	const config = sandboxConfig(input);
	options.configure?.(config);
	let url = "";
	let sandbox: Awaited<ReturnType<typeof createSandboxApp>> | undefined;
	const start = async () => {
		sandbox = await createSandboxApp(config, input, factory);
		({ address: url } = await sandbox.context.listen({
			host: "127.0.0.1",
			port: 0,
			useBoundAddressAsBaseUrl: true,
		}));
		input.urls.backend = config.server.base_url;
	};
	const current = () => {
		if (!sandbox) throw new Error("Sandbox is stopped");
		return sandbox;
	};
	try {
		await start();
	} catch (error) {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		throw error;
	}
	return {
		/** @public */
		root,
		/** @public */
		input,
		/** @public */
		config,
		/** @public */
		get context() {
			return current().context;
		},
		/** @public */
		get composition() {
			return current().composition;
		},
		/** @public */
		get url() {
			return url;
		},
		/** @public */
		poll: () => current().poll(),
		/** Stop, optionally change retained storage, then start on a new port. @public */
		async restart(whileStopped?: () => Promise<void>) {
			await current().stop();
			sandbox = undefined;
			await whileStopped?.();
			await start();
		},
		/** Admit a scenario through `/__local/scenarios`. @public */
		async admitScenario(
			name: string,
			request: {
				/** @public */
				requestId?: string;
				/** @public */
				input?: Record<string, unknown>;
			} = {},
		): Promise<SandboxScenarioResponse> {
			const response = await current().context.app.inject({
				method: "POST",
				url: "/__local/scenarios",
				payload: {
					name,
					requestId: request.requestId ?? `request-${crypto.randomUUID()}`,
					...(request.input ? { input: request.input } : {}),
				},
			});
			return { statusCode: response.statusCode, body: response.json() };
		},
		/** `T` describes the composition's `controlState` fields; it is not validated. @public */
		async controlState<T = Record<string, unknown>>(): Promise<T> {
			const response = await current().context.app.inject("/__local/state");
			if (response.statusCode !== 200)
				throw new Error(`Sandbox state returned HTTP ${response.statusCode}`);
			return response.json();
		},
		/** @public */
		async stop() {
			try {
				await sandbox?.stop();
			} finally {
				sandbox = undefined;
				await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		},
	};
}

/** @public */
export type SandboxHarness = Awaited<ReturnType<typeof startSandboxHarness>>;
