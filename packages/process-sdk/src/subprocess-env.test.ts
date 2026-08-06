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
