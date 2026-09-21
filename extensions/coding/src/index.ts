import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";

/** @internal */
const manifest = {
	/** @internal */
	id: "coding",
	/** @internal */
	version: "0.1.0",
} as const;
/** @public */
const extension: LeitwerkExtensionModule = { manifest };
export default extension;

export {
	acceptReviewForm,
	codingActionIds,
	requestReviewChangesForm,
	requestRevisionForm,
} from "./actions.js";
export { createRepositoryChangeProcess } from "./repository-change-process.js";
