import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { resolveRuntimeServerConfig } from "./runtime-server-config.js";

describe("resolveRuntimeServerConfig", () => {
	it("returns the configured server values when no env overrides are present", () => {
		const config = getDefaultConfig();
		config.server.host = "0.0.0.0";
		config.server.port = 9000;
		config.server.base_url = "http://localhost:9000";

		const resolved = resolveRuntimeServerConfig(config, {});

		expect(resolved.host).toBe("0.0.0.0");
		expect(resolved.port).toBe(9000);
		expect(resolved.baseUrl).toBe("http://localhost:9000");
		expect(resolved.config.server).toEqual({
			host: "0.0.0.0",
			port: 9000,
			base_url: "http://localhost:9000",
			websocket: config.server.websocket,
		});
	});

	it("patches the runtime config with env overrides", () => {
		const config = getDefaultConfig();
		const resolved = resolveRuntimeServerConfig(config, {
			HOST: "0.0.0.0",
			PORT: "9090",
			LEITWERK_BASE_URL: "http://localhost:9090",
			LEITWERK_LOCAL_WORKER_COMMAND: "node",
			LEITWERK_LOCAL_WORKER_ARGS_JSON: JSON.stringify([
				"--conditions=source",
				"--import",
				"tsx",
				"../worker/src/worker-entry.ts",
			]),
		});

		expect(resolved.host).toBe("0.0.0.0");
		expect(resolved.port).toBe(9090);
		expect(resolved.baseUrl).toBe("http://localhost:9090");
		expect(resolved.config.server.host).toBe("0.0.0.0");
		expect(resolved.config.server.port).toBe(9090);
		expect(resolved.config.server.base_url).toBe("http://localhost:9090");
		expect(resolved.config.local_worker?.command).toBe("node");
		expect(resolved.config.local_worker?.args).toEqual([
			"--conditions=source",
			"--import",
			"tsx",
			"../worker/src/worker-entry.ts",
		]);
	});

	it("rejects invalid worker args env overrides", () => {
		const config = getDefaultConfig();
		expect(() =>
			resolveRuntimeServerConfig(config, {
				LEITWERK_LOCAL_WORKER_ARGS_JSON: JSON.stringify({ nope: true }),
			}),
		).toThrow("LEITWERK_LOCAL_WORKER_ARGS_JSON must be a JSON string array");
	});
});
