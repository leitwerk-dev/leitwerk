import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { onTestFinished, test } from "vitest";
import { readSandboxSettings, type SandboxInput, withSandboxLaunchers } from "./index.js";

function launcherIds(definition: ExtensionProcessDefinition<unknown, unknown>): string[] {
	const ids: string[] = [];
	definition.launchers?.({
		launcher: (launcher: { id: string }) => ids.push(launcher.id),
	} as never);
	return ids;
}

const scenario = (name: string) => ({
	name,
	description: name,
	launch: () => ({ processId: "example", params: {} }) as never,
});

test("sandbox launchers keep, replace and do not stack on the process's own launchers", () => {
	const definition = {
		entryTurnId: "start",
		launchers(api: { launcher(input: { id: string }): void }) {
			api.launcher({ id: "example.ui" });
		},
	} as unknown as ExtensionProcessDefinition<unknown, unknown>;
	withSandboxLaunchers(definition, [scenario("first")]);
	assert.deepEqual(launcherIds(definition), ["example.ui", "sandbox.first"]);
	withSandboxLaunchers(definition, [
		scenario("second"),
		{ name: "nightly", description: "", launcherId: "example.ui" },
	]);
	assert.deepEqual(launcherIds(definition), ["example.ui", "sandbox.second"]);
	withSandboxLaunchers(definition, [scenario("third")], { ownLaunchers: "replace" });
	assert.deepEqual(launcherIds(definition), ["sandbox.third"]);
});

test("sandbox settings are optional, private and parsed as YAML", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sandbox-settings-test-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const input = { paths: { workspaceRoot: root } } as SandboxInput;
	assert.equal(readSandboxSettings(input, "demo"), undefined);
	const file = path.join(root, ".leitwerk", "sandbox", "demo.yaml");
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, "webhook: https://example.test/hook\n", { mode: 0o644 });
	await chmod(file, 0o644);
	assert.throws(() => readSandboxSettings(input, "demo"), /mode 0600/);
	await chmod(file, 0o600);
	assert.deepEqual(readSandboxSettings(input, "demo"), { webhook: "https://example.test/hook" });
	assert.throws(() => readSandboxSettings(input, "../demo"), /kebab-case/);
});
