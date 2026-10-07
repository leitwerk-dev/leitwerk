import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";

/** @internal */
export const manifest = {
	/** @internal */
	id: "coding",
	/** @internal */
	version: "0.1.0",
} as const;
/** @public */
const extension: LeitwerkExtensionModule = { manifest };
export default extension;

export * from "./actions.js";
export * from "./repository-change-launch.js";
export * from "./repository-change-process.js";
