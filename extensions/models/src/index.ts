import { defineModelProviders, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { resolveModelProviders } from "./models-provider.js";

export const manifest = {
	id: "models",
	version: "0.1.0",
} as const;

const modelsExtension = {
	manifest,
	modelProviders: defineModelProviders(resolveModelProviders),
} satisfies LeitwerkExtensionModule;

export default modelsExtension;
export * from "./models-provider.js";
export * from "./provider-auth.js";
