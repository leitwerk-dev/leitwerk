import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { testWorkspace } from "../test-workspace.js";

const launchSandbox = vi.fn();
vi.mock("@leitwerk-dev/dev-sandbox/launcher", () => ({ launchSandbox }));

const { runSandbox } = await import("./sandbox.js");

it("starts the declared sandbox through installed packages in release mode", async () => {
	const { root, json } = testWorkspace();
	json("package.json", { private: true, type: "module" });
	mkdirSync(path.join(root, "sandbox"));
	mkdirSync(path.join(root, "sandbox", "tests"));
	writeFileSync(path.join(root, "leitwerk.yaml"), "server: {}\n");
	writeFileSync(
		path.join(root, "leitwerk.composition.yaml"),
		"version: 1\nruntime_config: ./leitwerk.yaml\ntest_roots:\n  - ./sandbox/tests\nsandboxes:\n  demo: ./sandbox/composition.js\n",
	);
	writeFileSync(path.join(root, "sandbox/composition.js"), "export default () => ({})\n");
	json(".leitwerk/development.json", { mode: "release" });

	await runSandbox({ workspaceRoot: root }, ["--llm=scripted"]);

	expect(launchSandbox).toHaveBeenCalledWith(
		expect.objectContaining({
			workspaceRoot: root,
			compositionEntry: path.join(root, "sandbox/composition.js"),
			supervisorEntry: expect.any(String),
			args: ["--llm=scripted"],
		}),
	);
}, 10_000);

beforeEach(() => launchSandbox.mockReset());
