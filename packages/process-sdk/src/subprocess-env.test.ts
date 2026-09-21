import {
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { sanitizeWorkerSubprocessEnv } from "./subprocess-env.js";

describe("sanitizeWorkerSubprocessEnv", () => {
	it("removes worker IPC and snapshot credentials", () => {
		const env = sanitizeWorkerSubprocessEnv({
			PATH: "/bin",
			[WORKER_IPC_CONNECT_TOKEN_ENV]: "connect-secret",
			[WORKER_IPC_RECONNECT_ENV]: "1",
			[WORKER_SNAPSHOT_TOKEN_ENV]: "snapshot-secret",
		});

		expect(env).toEqual({ PATH: "/bin" });
	});

	it("does not allow overrides to reintroduce worker credentials", () => {
		const env = sanitizeWorkerSubprocessEnv(
			{ PATH: "/bin", KEEP: "base" },
			{ KEEP: "override", [WORKER_IPC_CONNECT_TOKEN_ENV]: "secret" },
		);

		expect(env).toEqual({ PATH: "/bin", KEEP: "override" });
	});
});

it("filters credential and helper variables after merging overrides", () => {
	const sensitive = Object.fromEntries(
		[
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"GIT_CONFIG_PARAMETERS",
			"GIT_CONFIG_GLOBAL",
			"GIT_SSH",
			"GIT_SSH_COMMAND",
			"GIT_ASKPASS",
			"SSH_ASKPASS",
			"SSH_AUTH_SOCK",
			"SSH_AGENT_PID",
			"LEITWERK_INTERNAL_REPOSITORY_GIT_SSH_HELPER",
			"LEITWERK_INTERNAL_REPOSITORY_GIT_HTTPS_HELPER",
			"FORGE_TOKEN",
			"API_KEY",
			"DB_PASSWORD",
			"CLIENT_SECRET",
		].map((key) => [key, "sensitive"]),
	);
	expect(
		sanitizeWorkerSubprocessEnv(
			{ ...sensitive, PATH: "/bin" },
			{ ...sensitive, KEEP: "ok", REMOVE: undefined },
		),
	).toEqual({ PATH: "/bin", KEEP: "ok" });
});
