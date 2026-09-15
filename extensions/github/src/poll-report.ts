import {
	createExternalSourcePollReporter,
	type ExternalSourceArmingLike,
	type ExternalSourceServiceLike,
} from "@leitwerk-dev/process-sdk";
import { sameSubscription } from "@leitwerk-dev/repository-rebase";
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
	const report = createExternalSourcePollReporter(sources, result);
	const current = (armed: ExternalSourceArmingLike) =>
		[
			GITHUB_CHECKS_KIND,
			GITHUB_PR_STATE_KIND,
			GITHUB_PR_TERMINAL_KIND,
			GITHUB_PR_FEEDBACK_KIND,
			GITHUB_ISSUE_CANCELLED_KIND,
			GITHUB_RELEASE_KIND,
		].some((kind) => sources.listArmed(kind).some((value) => sameSubscription(armed, value)));
	return {
		...report,
		async fire(
			armed: Parameters<typeof report.fire>[0],
			event: Record<string, unknown>,
			mergeKey: string,
		) {
			if (!current(armed as ExternalSourceArmingLike)) return false;
			const fired = await sources.fire({
				instanceId: armed.instanceId,
				armingId: armed.id,
				...(armed.generation ? { generation: armed.generation } : {}),
				event,
				mergeKey,
			});
			if (fired.ok) result.created.push(armed.id);
			else result.errors.push(`${armed.id}:fire_failed`);
			return fired.ok;
		},
		observe(
			armed: Parameters<typeof report.observe>[0],
			input: Parameters<typeof report.observe>[1],
		) {
			if (current(armed as ExternalSourceArmingLike)) return report.observe(armed, input);
		},
	};
}
