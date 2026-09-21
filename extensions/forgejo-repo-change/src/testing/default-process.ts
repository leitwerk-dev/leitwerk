import { createForgejoRepoChangeLauncher } from "../launcher.js";
import { createForgejoRepoChangeProcess } from "../process.js";

export const forgejoRepoChangeProcess = createForgejoRepoChangeProcess(
	createForgejoRepoChangeLauncher(),
	true,
);
