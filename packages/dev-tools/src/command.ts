import { type SpawnOptions, spawn } from "node:child_process";
import { signalProcessGroup } from "./child-process.js";

/** Forward cancellation to the whole command group, including npm's children. */
export function run(command: string, args: string[], options: SpawnOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", detached: true, ...options });
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const signal = (value: NodeJS.Signals) => {
			signalProcessGroup(child, value);
			killTimer ??= setTimeout(() => signalProcessGroup(child, "SIGKILL"), 30_000);
		};
		const interrupt = () => signal("SIGINT");
		const terminate = () => signal("SIGTERM");
		const cleanup = () => {
			clearTimeout(killTimer);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`));
		});
	});
}
