<script lang="ts">
import type { TurnProgressReport, TurnProgressStepStatus } from "@leitwerk-dev/domain";
import type { ChronicleChecklistTone } from "../lib/chronicle-checklist.js";
import ChronicleChecklist from "./ChronicleChecklist.svelte";

interface Props {
	report: TurnProgressReport;
}
let { report }: Props = $props();

const statusLabels: Record<TurnProgressStepStatus, string> = {
	incomplete: "Incomplete",
	in_progress: "In progress",
	completed: "Complete",
	failed: "Failed",
};
const statusTones: Record<TurnProgressStepStatus, ChronicleChecklistTone> = {
	incomplete: "pending",
	in_progress: "active",
	completed: "success",
	failed: "failed",
};

const steps = $derived(
	report.steps.map((step) => ({
		...step,
		statusLabel: statusLabels[step.status],
		tone: statusTones[step.status],
		sourceStatus: step.status,
	})),
);
</script>

<ChronicleChecklist
	title={report.title}
	{steps}
	links={report.links ?? []}
	section="turn-progress"
	ariaLive="polite"
/>
