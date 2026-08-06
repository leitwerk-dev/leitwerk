import { spawn } from "node:child_process";
import process from "node:process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
	console.error("Usage: node scripts/run-quiet.mjs <command> [args...]");
	process.exit(1);
}

const child = spawn(command, args, {
	stdio: ["inherit", "pipe", "pipe"],
	env: process.env,
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
	stdout += String(chunk);
});

child.stderr.on("data", (chunk) => {
	stderr += String(chunk);
});

child.on("close", (code) => {
	if (code !== 0) {
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		process.exit(code ?? 1);
	}
});
