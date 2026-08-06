import type { ChildProcess } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { loadDevContext } from "./dev-context.ts";
import { spawnTsx, stopManagedForExit } from "./dev-process.ts";

const lockDir = path.join(tmpdir(), "leitwerk-dev-port-locks");
const MAX_PORT = 65_535;

function formatBaseUrl(url: URL): string {
	const pathname = url.pathname === "/" ? "" : url.pathname;
	return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
}

function formatBaseUrlWithPort(baseUrl: string, port: number): string {
	const url = new URL(baseUrl);
	url.port = String(port);
	return formatBaseUrl(url);
}

interface PortReservation {
	port: number;
	release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH";
	}
}

async function tryAcquirePortLock(port: number): Promise<(() => Promise<void>) | null> {
	await mkdir(lockDir, { recursive: true });
	const lockPath = path.join(lockDir, `${port}.lock`);

	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${process.pid}\n`);
			await handle.close();
			return async () => {
				await rm(lockPath, { force: true });
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "EEXIST") {
				throw error;
			}

			const pidText = await readFile(lockPath, "utf8").catch(() => "");
			const pid = Number.parseInt(pidText.trim(), 10);
			if (Number.isFinite(pid) && !isProcessAlive(pid)) {
				await rm(lockPath, { force: true }).catch(() => {});
				continue;
			}
			return null;
		}
	}
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE" || error.code === "EACCES") {
				resolve(false);
				return;
			}
			reject(error);
		});
		server.listen({ host, port }, () => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(true);
			});
		});
	});
}

async function reservePort(
	host: string,
	requestedPort: number,
	options: { strict?: boolean } = {},
): Promise<PortReservation> {
	const maxPort = options.strict ? requestedPort : MAX_PORT;
	for (let port = requestedPort; port <= maxPort; port += 1) {
		const releaseLock = await tryAcquirePortLock(port);
		if (!releaseLock) {
			if (options.strict) {
				throw new Error(`Backend port ${port} is already reserved by another dev process`);
			}
			continue;
		}

		const available = await isPortAvailable(host, port).catch(async (error) => {
			await releaseLock();
			throw error;
		});
		if (!available) {
			await releaseLock();
			if (options.strict) {
				throw new Error(`Backend port ${port} is not available on ${host}`);
			}
			continue;
		}

		return { port, release: releaseLock };
	}

	throw new Error(`Could not find a free port on ${host} starting at ${requestedPort}`);
}

function envFlagEnabled(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function assertRequestedPort(port: number): void {
	if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
		throw new Error(`Invalid requested backend port: ${String(port)}`);
	}
}

function normalizeUiProxyHost(host: string): string {
	if (host === "0.0.0.0" || host === "::" || host === "[::]") {
		return "127.0.0.1";
	}
	return host;
}

function deriveUiProxyEnv(host: string, port: number): Record<string, string> {
	return {
		LEITWERK_API_PROTOCOL: "http",
		LEITWERK_API_HOST: normalizeUiProxyHost(host),
		LEITWERK_API_PORT: String(port),
	};
}

async function main(): Promise<void> {
	process.env.LEITWERK_RUNTIME_LANE = "source";
	const devContext = await loadDevContext();
	const extensionUiSources = devContext.extensions.flatMap((extension) =>
		extension.uiSource ? [extension.uiSource] : [],
	);

	const [configLoaderModule, runtimeServerConfigModule] = await Promise.all([
		import("../packages/server/src/config/config-loader.ts"),
		import("../packages/server/src/runtime-server-config.ts"),
	]);
	const { loadConfig } = configLoaderModule;
	const { resolveRuntimeServerConfig } = runtimeServerConfigModule;

	const loadedConfig = loadConfig(process.env.LEITWERK_CONFIG_PATH);
	if (!loadedConfig.ok) {
		throw new Error(loadedConfig.error);
	}

	const runtimeServer = resolveRuntimeServerConfig(loadedConfig.config, process.env);
	assertRequestedPort(runtimeServer.port);
	const reservation = await reservePort(runtimeServer.host, runtimeServer.port, {
		strict: envFlagEnabled(process.env.LEITWERK_DEV_STRICT_PORT),
	});
	const baseUrl = formatBaseUrlWithPort(runtimeServer.baseUrl, reservation.port);
	const uiProxyEnv = deriveUiProxyEnv(runtimeServer.host, reservation.port);

	if (reservation.port === runtimeServer.port) {
		console.info(`[dev] Backend port ${reservation.port} is available.`);
	} else {
		console.info(
			`[dev] Backend port ${runtimeServer.port} is busy, using ${reservation.port} instead.`,
		);
	}
	console.info(`[dev] Backend base URL: ${baseUrl}`);
	console.info(
		`[dev] Running source lane with ${devContext.extensions.length} configured extension(s); production dist is untouched.`,
	);

	const children: ChildProcess[] = [];
	let shuttingDown = false;

	const releaseReservation = async () => {
		await reservation.release().catch(() => {});
	};

	const finish = async (exitCode: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		await Promise.all(children.map((child) => stopManagedForExit(child, exitCode, 25_000, 1_500)));
		await releaseReservation();
		process.exit(exitCode);
	};

	process.once("SIGINT", () => {
		void finish(130);
	});
	process.once("SIGTERM", () => {
		void finish(143);
	});
	process.once("exit", () => {
		void reservation.release().catch(() => {});
	});

	const sharedEnv = {
		...process.env,
		HOST: runtimeServer.host,
		PORT: String(reservation.port),
		LEITWERK_BASE_URL: baseUrl,
	};
	const sourceEnv = { ...sharedEnv, LEITWERK_RUNTIME_LANE: "source" };
	const uiEnv = {
		...sourceEnv,
		LEITWERK_DEV_EXTENSION_UI_SOURCES_JSON: JSON.stringify(extensionUiSources),
	};

	const track = (child: ChildProcess): ChildProcess => {
		children.push(child);
		child.once("error", () => {
			if (shuttingDown) {
				return;
			}
			void finish(1);
		});
		child.once("exit", (code, signal) => {
			if (shuttingDown) {
				return;
			}
			const exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
			void finish(exitCode);
		});
		return child;
	};

	const spawnDevScript = (scriptPath: string, env: NodeJS.ProcessEnv): ChildProcess =>
		spawnTsx(scriptPath, { cwd: process.cwd(), env, stdio: "inherit" });

	track(spawnDevScript("scripts/dev-server-source.ts", sourceEnv));
	track(spawnDevScript("scripts/dev-ui.ts", { ...uiEnv, ...uiProxyEnv }));
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
