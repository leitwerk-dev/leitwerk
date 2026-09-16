import { type SpawnSyncOptions, spawnSync } from "node:child_process";

export function runCommand(command: string, args: string[], options: SpawnSyncOptions = {}): void {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
