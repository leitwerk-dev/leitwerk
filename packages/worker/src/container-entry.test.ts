import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runWorkerContainerEntrypoint } from "./container-entry.js";

function child() {
	const value = new EventEmitter() as ChildProcess;
	Object.assign(value, {
		pid: 1,
		exitCode: null,
		signalCode: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => {
			(value as { signalCode: NodeJS.Signals | null }).signalCode = "SIGTERM";
			value.emit("exit", null, "SIGTERM");
			return true;
		}),
	});
	return value;
}

function exit(value: ChildProcess, code: number) {
	(value as { exitCode: number | null }).exitCode = code;
	value.emit("exit", code, null);
}

function deps(spawned: ChildProcess[], overrides: Record<string, unknown> = {}) {
	let time = 0;
	return {
		spawn: vi.fn(() => spawned.shift() as ChildProcess) as unknown as typeof spawn,
		dockerInfo: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		now: () => time,
		delay: vi.fn(async (ms: number) => {
			time += ms;
		}),
		warn: vi.fn(),
		...overrides,
	};
}

describe("worker container entrypoint", () => {
	it("starts only the worker in ordinary mode", async () => {
		const worker = child();
		const runtime = deps([worker]);
		const env = {
			DOCKER_HOST: "tcp://operator-daemon:2376",
			DOCKER_CONTEXT: "operator-context",
			DOCKER_TLS_VERIFY: "1",
			DOCKER_CERT_PATH: "/operator/certs",
		};
		const running = runWorkerContainerEntrypoint(env, runtime);
		exit(worker, 0);
		await expect(running).resolves.toBe(0);
		expect(runtime.spawn).toHaveBeenCalledOnce();
		expect(runtime.spawn.mock.calls[0]?.[1]?.[0]).toMatch(/worker-entry\.js$/u);
		expect(runtime.spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), {
			stdio: "inherit",
			env,
		});
		expect(runtime.dockerInfo).not.toHaveBeenCalled();
	});

	it("pins every private Docker subprocess to its daemon despite image environment overrides", async () => {
		const daemon = child();
		const worker = child();
		const runtime = deps([daemon, worker]);
		const env = {
			LEITWERK_PRIVATE_DOCKER: "1",
			DOCKER_HOST: "tcp://external-daemon:2376",
			DOCKER_CONTEXT: "external-context",
			DOCKER_TLS: "1",
			DOCKER_TLS_VERIFY: "1",
			DOCKER_CERT_PATH: "/external/certs",
			DOCKER_CONFIG: "/registry-auth",
			PATH: "/worker/bin:/usr/bin",
		};
		const privateEnv = {
			LEITWERK_PRIVATE_DOCKER: "1",
			DOCKER_HOST: "unix:///var/run/docker.sock",
			DOCKER_CONFIG: "/registry-auth",
			PATH: "/worker/bin:/usr/bin",
		};
		const running = runWorkerContainerEntrypoint(env, runtime);
		await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2));
		expect(runtime.spawn).toHaveBeenNthCalledWith(1, "dockerd", expect.any(Array), {
			stdio: ["ignore", "pipe", "pipe"],
			env: privateEnv,
		});
		expect(runtime.spawn).toHaveBeenNthCalledWith(2, process.execPath, expect.any(Array), {
			stdio: "inherit",
			env: privateEnv,
		});
		expect(runtime.dockerInfo).toHaveBeenCalledWith(privateEnv, expect.any(AbortSignal));
		expect(env.DOCKER_CONTEXT).toBe("external-context");
		expect(env.DOCKER_HOST).toBe("tcp://external-daemon:2376");
		exit(worker, 0);
		await expect(running).resolves.toBe(0);
	});

	it.each([
		"ENOENT",
		"EACCES",
	])("reports dockerd spawn %s without resetting its data", async (code) => {
		const directory = await mkdtemp(join(tmpdir(), "leitwerk-container-entry-"));
		const executable = join(directory, "dockerd");
		try {
			if (code === "EACCES") {
				await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o600 });
			}
			const runtime = deps([], {
				spawn: vi.fn((_command, args, options) => spawn(executable, args, options)),
				dockerInfo: vi.fn(() => new Promise<void>(() => undefined)),
			});
			await expect(
				runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime),
			).rejects.toThrow(`Failed to start dockerd: spawn ${executable} ${code}`);
			expect(runtime.spawn).toHaveBeenCalledOnce();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reports a worker spawn failure and stops its daemon without retrying readiness", async () => {
		const daemon = child();
		const worker = child();
		const runtime = deps([daemon, worker]);
		const running = runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime);
		await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2));
		worker.emit("error", new Error(`spawn ${process.execPath} EACCES`));
		await expect(running).rejects.toThrow(`Failed to start ${process.execPath}: spawn`);
		expect(daemon.kill).toHaveBeenCalled();
		expect(runtime.dockerInfo).toHaveBeenCalledOnce();
		expect(runtime.spawn).toHaveBeenCalledTimes(2);
	});

	it("waits for daemon readiness before starting the worker", async () => {
		const daemon = child();
		const worker = child();
		const runtime = deps([daemon, worker]);
		const running = runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime);
		await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2));
		expect(runtime.dockerInfo).toHaveBeenCalled();
		exit(worker, 0);
		await expect(running).resolves.toBe(0);
	});

	it("stops pending readiness on SIGTERM without resetting data or spawning again", async () => {
		const daemon = child();
		const probe = Promise.withResolvers<void>();
		const dockerInfo = vi.fn((_env: NodeJS.ProcessEnv, _signal: AbortSignal) => probe.promise);
		const runtime = deps([daemon], { dockerInfo });
		const running = runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime);
		await vi.waitFor(() => expect(dockerInfo).toHaveBeenCalledOnce());

		process.emit("SIGTERM");
		await expect(running).resolves.toBe(0);
		expect(dockerInfo.mock.calls[0]?.[1].aborted).toBe(true);
		expect(daemon.kill).toHaveBeenCalled();
		expect(runtime.spawn).toHaveBeenCalledOnce();

		probe.resolve();
		await probe.promise;
		expect(runtime.spawn).toHaveBeenCalledOnce();
	});

	it("does not spawn a daemon when shutdown interrupts directory preparation", async () => {
		const directory = Promise.withResolvers<void>();
		const runtime = deps([], { mkdir: vi.fn(() => directory.promise) });
		const running = runWorkerContainerEntrypoint({ LEITWERK_PRIVATE_DOCKER: "1" }, runtime);
		process.emit("SIGTERM");
		directory.resolve();
		await expect(running).resolves.toBe(0);
		expect(runtime.spawn).not.toHaveBeenCalled();
	});

	it.each(["ready", "failed"])("retains Docker data when the retry is %s", async (outcome) => {
		const directory = await mkdtemp(join(tmpdir(), "leitwerk-docker-data-"));
		const dockerDataRoot = join(directory, "tooling", "docker");
		await mkdir(dockerDataRoot, { recursive: true });
		const retainedImage = join(dockerDataRoot, "retained-image");
		await writeFile(retainedImage, "keep this image");
		const first = child();
		const second = child();
		const worker = child();
		let checks = 0;
		const runtime = deps([first, second, worker], {
			dockerInfo: vi.fn(async () => {
				checks += 1;
				if (checks === 1) exit(first, 1);
				if (checks === 2 && outcome === "failed") exit(second, 1);
			}),
		});
		try {
			const running = runWorkerContainerEntrypoint(
				{ LEITWERK_PRIVATE_DOCKER: "1", LEITWERK_PROCESS_VOLUME_MOUNT_PATH: directory },
				runtime,
			);
			if (outcome === "ready") {
				await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(3));
				exit(worker, 0);
				await expect(running).resolves.toBe(0);
				expect(runtime.warn).toHaveBeenCalledWith(expect.stringContaining("retained data"));
			} else {
				await expect(running).rejects.toThrow("Private Docker daemon failed twice");
				expect(runtime.spawn).toHaveBeenCalledTimes(2);
			}
			expect(await readFile(retainedImage, "utf8")).toBe("keep this image");
			for (const call of runtime.spawn.mock.calls.slice(0, 2)) {
				expect(call[1]).toContain(dockerDataRoot);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not reset a live daemon when readiness times out", async () => {
		const daemon = child();
		const runtime = deps([daemon], {
			dockerInfo: vi.fn().mockRejectedValue(new Error("not ready")),
		});
		await expect(
			runWorkerContainerEntrypoint(
				{ LEITWERK_PRIVATE_DOCKER: "1", LEITWERK_WORKER_STARTUP_TIMEOUT_MS: "500" },
				runtime,
			),
		).rejects.toThrow(/readiness timed out/);
	});

	it("shares one absolute readiness deadline across recovery attempts", async () => {
		const first = child();
		const second = child();
		let time = 0;
		let checks = 0;
		const dockerInfo = vi.fn(async () => {
			checks += 1;
			if (checks === 1) {
				time = 450;
				exit(first, 1);
			} else throw new Error("not ready");
		});
		const runtime = deps([first, second], {
			now: () => time,
			dockerInfo,
			delay: vi.fn(async (ms: number) => {
				time += ms;
			}),
		});

		await expect(
			runWorkerContainerEntrypoint(
				{ LEITWERK_PRIVATE_DOCKER: "1", LEITWERK_WORKER_STARTUP_DEADLINE_MS: "500" },
				runtime,
			),
		).rejects.toThrow(/readiness timed out/);
		expect(dockerInfo).toHaveBeenCalledTimes(2);
	});
});
