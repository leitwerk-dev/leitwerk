import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import type { FileReader } from "./server-topology.js";
import { resolveServerTlsOptions } from "./server-topology.js";

function fakeFiles(files: Record<string, string>): FileReader {
	return (path) => {
		const contents = files[path];
		if (contents === undefined) {
			throw new Error(`unexpected read of ${path}`);
		}
		return contents;
	};
}

describe("resolveServerTlsOptions", () => {
	it("returns null when internal TLS is disabled (default)", () => {
		const config = getDefaultConfig();
		expect(resolveServerTlsOptions(config)).toBeNull();
	});

	it("loads cert and key without mTLS when no client CA is configured", () => {
		const config = getDefaultConfig();
		config.internal_tls = {
			enabled: true,
			cert_file: "/etc/tls/server.crt",
			key_file: "/etc/tls/server.key",
		};
		const options = resolveServerTlsOptions(
			config,
			fakeFiles({ "/etc/tls/server.crt": "CERT", "/etc/tls/server.key": "KEY" }),
		);
		expect(options).toEqual({
			cert: "CERT",
			key: "KEY",
			requestCert: false,
			rejectUnauthorized: false,
		});
	});

	it("maps client CA to TLS verification options for the reserved future mTLS mode", () => {
		const config = getDefaultConfig();
		config.internal_tls = {
			enabled: true,
			cert_file: "/etc/tls/server.crt",
			key_file: "/etc/tls/server.key",
			client_ca_file: "/etc/tls/clients.pem",
		};
		const options = resolveServerTlsOptions(
			config,
			fakeFiles({
				"/etc/tls/server.crt": "CERT",
				"/etc/tls/server.key": "KEY",
				"/etc/tls/clients.pem": "CA",
			}),
		);
		expect(options).toEqual({
			cert: "CERT",
			key: "KEY",
			ca: "CA",
			requestCert: true,
			rejectUnauthorized: true,
		});
	});

	it("throws when enabled without cert and key", () => {
		const config = getDefaultConfig();
		config.internal_tls = { enabled: true };
		expect(() => resolveServerTlsOptions(config)).toThrow(/cert_file and key_file/);
	});
});
