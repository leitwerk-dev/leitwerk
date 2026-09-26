import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { codingSettings } from "./settings.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "coding",
	/** @internal */
	version: "0.1.0",
} as const;
/** @public */
const extension: LeitwerkExtensionModule = { manifest, scopedSettings: codingSettings };
export default extension;

export {
	acceptReviewForm,
	codingActionIds,
	requestReviewChangesForm,
	requestRevisionForm,
} from "./actions.js";
export { createRepositoryChangeProcess } from "./repository-change-process.js";

export { codingPurposes, codingSettings, repositoryInstructions } from "./settings.js";
