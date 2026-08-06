import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveManagedPiAgentDir, writeManagedPiCredentialFiles } from "./managed-pi-agent-dir.js";

const roots: string[] = [];
async function root(): Promise<string> {
	const value = await mkdtemp(path.join(tmpdir(), "leitwerk-managed-agent-"));
	roots.push(value);
	return value;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("managed Pi agent directory", () => {
	it("rejects ambient agent dir and unsafe identifiers", () => {
		expect(() =>
			resolveManagedPiAgentDir({
				agentDirRoot: path.join(homedir(), ".pi", "agent"),
				instanceId: "instance",
				startOrLeaseId: "start",
			}),
		).toThrow("must not be ambient");
		expect(() =>
			resolveManagedPiAgentDir({
				agentDirRoot: "/tmp/agent",
				instanceId: "../instance",
				startOrLeaseId: "start",
			}),
		).toThrow("Invalid managed Pi instance id");
	});

	it("writes declared credential files atomically with private permissions", async () => {
		const agentDir = await root();
		await writeManagedPiCredentialFiles(agentDir, [
			{ path: "auth.json", content: '{"key":"secret"}' },
			{ path: "provider/token", content: "token" },
		]);
		expect(await readFile(path.join(agentDir, "auth.json"), "utf8")).toContain("secret");
		expect((await lstat(path.join(agentDir, "auth.json"))).mode & 0o777).toBe(0o600);
		expect((await lstat(path.join(agentDir, "provider", "token"))).mode & 0o777).toBe(0o600);
		await expect(
			writeManagedPiCredentialFiles(agentDir, [{ path: "../outside", content: "no" }]),
		).rejects.toThrow("Invalid credential file path");
	});
});
