import { defineModelProviders, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { resolveModelProviders } from "./models-provider.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "models",
	/** @internal */
	version: "0.1.0",
} as const;

/** @public */
const modelsExtension: LeitwerkExtensionModule = {
	/** @internal */
	manifest,
	/** @internal */
	modelProviders: defineModelProviders(resolveModelProviders),
};

export default modelsExtension;
