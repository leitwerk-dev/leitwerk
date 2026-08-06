import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContext } from "./app.js";
import { getDefaultConfig } from "./config/index.js";

const fixturesDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"test-fixtures",
	"tls",
);
const certFile = path.join(fixturesDir, "internal-server.crt");
const keyFile = path.join(fixturesDir, "internal-server.key");

/** GET over HTTPS trusting only the provided CA (verifies real TLS termination). */
function httpsGet(url: string, ca: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const req = httpsRequest(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "GET",
				ca,
				// The fixture cert has a SAN for "localhost"; connect by that name.
				servername: "localhost",
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("internal TLS listener", () => {
	let close: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await close?.();
		close = undefined;
	});

	it("serves the internal endpoint over HTTPS when internal_tls is enabled", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		config.internal_tls = { enabled: true, cert_file: certFile, key_file: keyFile };
		if (config.docker) {
			config.docker.server_url = "https://leitwerk-server:8080";
			config.docker.server_ca_file = certFile;
		}

		const ctx = await createAppContext({
			config,
			logger: false,
			extensionCatalog: buildExtensionCatalogFromModules([]),
		});
		close = () => ctx.app.close();

		const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
		expect(address.startsWith("https://")).toBe(true);

		const port = new URL(address).port;
		const result = await httpsGet(
			`https://localhost:${port}/api/health`,
			readFileSync(certFile, "utf8"),
		);
		expect(result.status).toBe(200);
		expect(JSON.parse(result.body)).toMatchObject({ status: "ok" });
	});

	it("serves plain HTTP when internal_tls is disabled (default)", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";

		const ctx = await createAppContext({
			config,
			logger: false,
			extensionCatalog: buildExtensionCatalogFromModules([]),
		});
		close = () => ctx.app.close();

		const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
		expect(address.startsWith("http://")).toBe(true);

		const response = await fetch(`${address}/api/health`);
		expect(response.ok).toBe(true);
		const body = (await response.json()) as { status: string };
		expect(body.status).toBe("ok");
	});
});
