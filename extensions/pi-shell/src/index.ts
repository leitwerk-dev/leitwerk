import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { piShellProcess } from "./process-definition.js";

export const manifest = {
	id: "pi-shell",
	version: "0.1.0",
} as const;

const piShellExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerProcess(piShellProcess);
	},
};

export default piShellExtension;
export * from "./process-definition.js";
export * from "./state.js";
