import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDiagnostics } from "@leitwerk-dev/test-support/local-git";
import { expect, it, onTestFailed } from "vitest";
import { expected, fixture } from "./test-fixture.ts";

it.each([
	false,
	true,
])("runs the canary through physical replacement and detects changed retained storage (%s)", async (replaceStorage) => {
	const trace = createTestDiagnostics(`docker canary replaceStorage=${replaceStorage}`);
	onTestFailed(() => trace.report());
	const root = mkdtempSync(path.join(tmpdir(), "leitwerk-docker-canary-"));
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	const callsFile = path.join(root, "calls");
	const evidence = path.join(root, "evidence");
	for (const generation of [1, 2]) {
		const { pod, pvc, pv } = fixture();
		pod.metadata.name = "docker-canary";
		pod.metadata.namespace = "fixture-canary";
		pod.metadata.uid = `pod-${generation}`;
		pod.spec.volumes[0].persistentVolumeClaim.claimName = "docker-state";
		pvc.metadata.name = "docker-state";
		pvc.metadata.namespace = "fixture-canary";
		pv.spec.claimRef.name = "docker-state";
		pv.spec.claimRef.namespace = "fixture-canary";
		if (replaceStorage && generation > 1) {
			pvc.metadata.uid = "other-pvc";
			pv.spec.claimRef.uid = "other-pvc";
		}
		for (const [kind, value] of Object.entries({ pod, pvc, pv })) {
			writeFileSync(path.join(root, `${kind}-${generation}.json`), JSON.stringify(value));
		}
	}
	writeFileSync(
		path.join(bin, "kubectl"),
		readFileSync(new URL("./fake-kubectl.sh", import.meta.url)),
		{ mode: 0o700 },
	);
	try {
		// Two physical-generation shell passes include many process launches.
		const timeoutMs = 45_000;
		trace.mark("canary.spawn.start", { timeoutMs });
		const started = performance.now();
		const child = spawn(
			"/bin/bash",
			[path.resolve("scripts/docker-runtime/test-kubernetes-runner.sh")],
			{
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					CANARY_FIXTURE_ROOT: root,
					PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
					LEITWERK_WORKER_IMAGE: expected.workerImage,
					LEITWERK_RUNTIME_CLASS_NAME: expected.runtimeClass,
					LEITWERK_DOCKER_STORAGE_CLASS_NAME: expected.storageClass,
					LEITWERK_DOCKER_TEST_NAMESPACE: "fixture-canary",
					LEITWERK_DOCKER_EVIDENCE_DIR: evidence,
				},
			},
		);
		let stdout = "";
		let stderr = "";
		let error: NodeJS.ErrnoException | undefined;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (cause) => {
			error = cause;
		});
		const signalGroup = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
					error = cause as NodeJS.ErrnoException;
			}
		};
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const deadline = setTimeout(() => {
			error = Object.assign(new Error(`Canary exceeded ${timeoutMs}ms`), { code: "ETIMEDOUT" });
			trace.mark("canary.timeout");
			signalGroup("SIGTERM");
			escalation = setTimeout(() => signalGroup("SIGKILL"), 5_000);
		}, timeoutMs);
		const result = await new Promise<{
			pid: number | undefined;
			status: number | null;
			signal: NodeJS.Signals | null;
			error: NodeJS.ErrnoException | undefined;
			stdout: string;
			stderr: string;
		}>((resolve) => {
			child.once("close", (status, signal) => {
				clearTimeout(deadline);
				clearTimeout(escalation);
				// No descendant may outlive the owned shell or fixture storage.
				signalGroup("SIGKILL");
				resolve({ pid: child.pid, status, signal, error, stdout, stderr });
			});
		});
		trace.mark("canary.spawn.exit", {
			pid: result.pid,
			durationMs: Math.round(performance.now() - started),
			status: result.status,
			signal: result.signal,
			error: result.error
				? { message: result.error.message, code: (result.error as NodeJS.ErrnoException).code }
				: null,
		});
		const callsText = existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "";
		const records = callsText.split("\0");
		const calls: { pid: string; args: string[]; input: string }[] = [];
		const exits: { pid: string; code: number }[] = [];
		for (let index = 0; index < records.length - 1; ) {
			const stage = records[index++];
			const pid = records[index++];
			const value = Number(records[index++]);
			if (stage === "exit") exits.push({ pid, code: value });
			else {
				expect(stage).toBe("start");
				const args = records.slice(index, index + value);
				index += value;
				calls.push({ pid, args, input: records[index++] });
			}
		}
		trace.mark("kubectl.tail", {
			calls: calls.slice(-10),
			exits: exits.slice(-10),
			unmatched: calls.filter((call) => !exits.some((exit) => exit.pid === call.pid)),
			stdout: result.stdout,
			stderr: result.stderr,
		});
		expect(result.error, result.stdout + result.stderr).toBeUndefined();
		expect(result.signal, result.stdout + result.stderr).toBeNull();
		expect(result.status, result.stdout + result.stderr).toBe(replaceStorage ? 1 : 0);
		const before = JSON.parse(readFileSync(path.join(evidence, "before/evidence.json"), "utf8"));
		expect(before).toMatchObject({
			podUid: "pod-1",
			pvcUid: "pvc-1",
			marker: "retained-workspace",
		});
		if (replaceStorage) expect(result.stderr).toContain("Replacement did not retain pvcUid");
		else {
			const after = JSON.parse(readFileSync(path.join(evidence, "after/evidence.json"), "utf8"));
			expect(after).toMatchObject({
				podUid: "pod-2",
				pvcUid: "pvc-1",
				replacesPodUid: "pod-1",
				innerImageId: before.innerImageId,
				workerImageId: before.workerImageId,
				marker: before.marker,
			});
			expect(after.previousPodDeletedAt).toBeDefined();
			expect(statSync(path.join(evidence, "after/evidence.json")).mode & 0o777).toBe(0o600);
		}
		expect(exits).toHaveLength(calls.length);
		expect(exits.every((exit) => exit.code === 0)).toBe(true);
		const podStarts = calls.flatMap((call, index) =>
			call.input.includes("kind: Pod") ? [index] : [],
		);
		const deletion = calls.findIndex(
			(call) => call.args.includes("delete") && call.args.includes("pod"),
		);
		const confirmed = calls.findIndex((call) => call.args.includes("--for=delete"));
		expect(podStarts).toHaveLength(2);
		expect(deletion).toBeGreaterThan(podStarts[0]);
		expect(confirmed).toBeGreaterThan(deletion);
		expect(podStarts[1]).toBeGreaterThan(confirmed);
		expect(calls.at(-1)?.args).toContain("namespace");
		expect(calls.at(-1)?.args).toContain("delete");
	} finally {
		trace.mark("cleanup.start");
		rmSync(root, { recursive: true, force: true });
		trace.mark("cleanup.end");
	}
}, 60_000);
