import {
	createExternalSourcePollReporter,
	type ExternalSourceServiceLike,
} from "@leitwerk-dev/process-sdk";
import {
	GITHUB_CHECKS_KIND,
	GITHUB_ISSUE_CANCELLED_KIND,
	GITHUB_PR_FEEDBACK_KIND,
	GITHUB_PR_STATE_KIND,
	GITHUB_PR_TERMINAL_KIND,
	GITHUB_RELEASE_KIND,
} from "./external.js";

export function githubPollReporter(
	sources: ExternalSourceServiceLike,
	result: { created: string[]; errors: string[] },
) {
	return createExternalSourcePollReporter(sources, result, {
		forwardGeneration: true,
		currentKinds: [
			GITHUB_CHECKS_KIND,
			GITHUB_PR_STATE_KIND,
			GITHUB_PR_TERMINAL_KIND,
			GITHUB_PR_FEEDBACK_KIND,
			GITHUB_ISSUE_CANCELLED_KIND,
			GITHUB_RELEASE_KIND,
		],
	});
}
