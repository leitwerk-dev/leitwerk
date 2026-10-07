import { asUnknownRecord } from "@leitwerk-dev/domain";

/** @internal */
export function parseJiraModelLabels(config: unknown): Readonly<Record<string, string>> {
	const raw = asUnknownRecord(config)?.model_labels;
	if (raw === undefined) return {};
	const labels = asUnknownRecord(raw);
	if (!labels) throw new Error("Jira model_labels must map labels to model profile IDs");
	const result: Record<string, string> = {};
	for (const [label, profile] of Object.entries(labels)) {
		if (
			!/^leitwerk-model-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) ||
			typeof profile !== "string" ||
			!profile.trim()
		)
			throw new Error("Jira model_labels requires leitwerk-model-* labels and model profile IDs");
		result[label] = profile.trim();
	}
	return result;
}

/** @internal */
export function selectJiraModel(
	labels: readonly string[],
	profiles: Readonly<Record<string, string>>,
) {
	const selected = [...new Set(labels.filter((label) => label.startsWith("leitwerk-model-")))];
	if (selected.length > 1)
		throw new Error("Select only one leitwerk-model-* label before starting the change");
	const label = selected[0];
	if (!label) return undefined;
	const profileId = profiles[label];
	if (!profileId) throw new Error(`Unknown Jira model label ${label}; correct the label and retry`);
	return { label, profileId };
}
