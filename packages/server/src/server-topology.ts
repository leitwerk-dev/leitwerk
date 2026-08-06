import { readFileSync } from "node:fs";
import type { LeitwerkConfig } from "./config/config-types.js";

/** Reads a file's UTF-8 contents. Injected so the pure logic stays testable. */
export type FileReader = (path: string) => string;

const defaultFileReader: FileReader = (path) => readFileSync(path, "utf8");

/**
 * Internal-listener TLS options for the server, shaped for Fastify's `https`
 * constructor option (which forwards to Node's TLS server).
 *
 * `requestCert` + `rejectUnauthorized` would turn on worker client-certificate
 * verification. Config validation currently rejects `internal_tls.client_ca_file`
 * until workers receive client cert/key material.
 */
export interface ServerTlsOptions {
	cert: string;
	key: string;
	ca?: string;
	requestCert: boolean;
	rejectUnauthorized: boolean;
}

/**
 * Resolves the server's internal TLS listener options, or `null` to stay on
 * plain HTTP (the default, so local and parity runs are unaffected).
 *
 * Public UI/API HTTPS terminates at a reverse proxy in front of the server;
 * this TLS is for the internal worker → server IPC endpoint, presenting a cert
 * with a SAN for the stable internal name. Worker client-certificate
 * verification is intentionally not configurable yet because workers do not
 * receive client cert/key material.
 */
export function resolveServerTlsOptions(
	config: LeitwerkConfig,
	readFile: FileReader = defaultFileReader,
): ServerTlsOptions | null {
	const tls = config.internal_tls;
	if (!tls || tls.enabled !== true) {
		return null;
	}
	if (!tls.cert_file || !tls.key_file) {
		throw new Error("internal_tls requires cert_file and key_file when enabled");
	}
	const cert = readFile(tls.cert_file);
	const key = readFile(tls.key_file);
	const ca = tls.client_ca_file ? readFile(tls.client_ca_file) : undefined;
	const mtls = ca !== undefined;
	return {
		cert,
		key,
		...(ca !== undefined ? { ca } : {}),
		requestCert: mtls,
		rejectUnauthorized: mtls,
	};
}
