import { spawnSync } from "node:child_process";
import process from "node:process";
import { activateDevelopmentComposition } from "./development-composition.ts";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
activateDevelopmentComposition(process.cwd());
const phases = [
	"lint",
	"parity:build",
	"test:server-start",
	"test:default-worker",
	"check:boundaries",
	"release:check",
	"typecheck",
	"test:parity:built",
	"test:unit",
	"test:integration",
	"test:e2e",
	"test:browser",
];
for (const phase of phases) {
	console.info(`[test:full] ${phase}`);
	const result = spawnSync(npm, ["run", "--silent", phase], {
		cwd: process.cwd(),
		env: {
			...process.env,
			TURBO_DISABLE_UPDATE_CHECK: "1",
			NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" "),
		},
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
