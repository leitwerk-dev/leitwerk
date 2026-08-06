import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";

export const manifest = { id: "coding", version: "0.1.0" } as const;
const extension: LeitwerkExtensionModule = { manifest };
export default extension;

export * from "./actions.js";
export * from "./repository-change-launch.js";
export * from "./repository-change-process.js";
