import type { TurnProgressReport } from "./domain-model.js";

export const AUTOMATIC_TURN_FAILED_PROGRESS_DETAIL =
	"Automatic turn failed. See the turn error for details.";

export function failActiveTurnProgress(report: TurnProgressReport): TurnProgressReport {
	return {
		...report,
		steps: report.steps.map((step) =>
			step.status === "in_progress"
				? { ...step, status: "failed", detail: AUTOMATIC_TURN_FAILED_PROGRESS_DETAIL }
				: step,
		),
	};
}
