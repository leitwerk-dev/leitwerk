import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	parseSessionTransferHelperSpec,
	prepareTransferArchive,
} from "@leitwerk-dev/session-transfer";

export const SESSION_TRANSFER_HELPER_ENTRY_PATH =
	"/app/packages/worker-runners/dist/session-transfer-helper.js";
export const SESSION_TRANSFER_HELPER_MOUNT_PATH = "/state";

interface HelperEnvironment {
	exportId: string;
	credential: string;
	serverUrl: URL;
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function readEnvironment(): HelperEnvironment {
	const serverUrl = new URL(required("LEITWERK_EXPORT_SERVER_URL"));
	if (!/^https?:$/.test(serverUrl.protocol) || serverUrl.username || serverUrl.password) {
		throw new Error("Invalid helper server URL");
	}
	return {
		exportId: required("LEITWERK_EXPORT_ID"),
		credential: required("LEITWERK_EXPORT_CREDENTIAL"),
		serverUrl,
	};
}

function helperUrl(environment: HelperEnvironment, suffix: string): URL {
	return new URL(
		`/internal/session-transfer-exports/${encodeURIComponent(environment.exportId)}${suffix}`,
		environment.serverUrl,
	);
}

async function helperFetch(
	environment: HelperEnvironment,
	suffix: string,
	init: RequestInit & { duplex?: "half" },
): Promise<Response> {
	const response = await fetch(helperUrl(environment, suffix), {
		...init,
		redirect: "manual",
		headers: {
			...init.headers,
			Authorization: `Bearer ${environment.credential}`,
		},
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Helper request failed with HTTP ${response.status}`);
	}
	return response;
}

async function helperRequest(
	environment: HelperEnvironment,
	suffix: string,
	init: RequestInit & { duplex?: "half" },
): Promise<void> {
	const response = await helperFetch(environment, suffix, init);
	await response.arrayBuffer();
}

async function readHelperSpec(environment: HelperEnvironment) {
	const response = await helperFetch(environment, "/spec", { method: "GET" });
	return parseSessionTransferHelperSpec(await response.json());
}

export async function runSessionTransferHelper(): Promise<void> {
	const environment = readEnvironment();
	const spec = await readHelperSpec(environment);
	const workspaceRoot = path.join(SESSION_TRANSFER_HELPER_MOUNT_PATH, "workspace");
	const sessionFile = path.join(SESSION_TRANSFER_HELPER_MOUNT_PATH, "tree", "primary.jsonl");
	const prepared = await prepareTransferArchive({
		workspaceRoot,
		sessionFile,
		manifest: spec.manifest,
		limits: spec.limits,
	});
	await helperRequest(environment, "/preflight", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			manifest: prepared.manifest,
			preflight: {
				entriesTotal: prepared.preflight.entriesTotal,
				logicalBytesTotal: prepared.preflight.logicalBytesTotal,
			},
		}),
	});
	const archive = prepared.stream({});
	await helperRequest(environment, "/stream", {
		method: "PUT",
		headers: { "Content-Type": "application/vnd.leitwerk.session-transfer+tar+zstd" },
		body: Readable.toWeb(archive) as ReadableStream,
		duplex: "half",
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	runSessionTransferHelper().catch(() => {
		process.exitCode = 1;
	});
}
