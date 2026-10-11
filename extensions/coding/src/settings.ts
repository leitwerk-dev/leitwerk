import type { ScopedSettingsDeclaration, SettingDefinition } from "@leitwerk-dev/process-sdk";

/** @public */
export const codingPurposes = {
	/** @public */
	planning: "coding.planning",
	/** @public */
	implementation: "coding.implementation",
	/** @public */
	review: "coding.review",
} as const;

/** @internal */
export const commitMessageGitTimeout: SettingDefinition<number> = {
	key: "coding.commit_message_git_timeout_ms",
	schemaVersion: 1,
	scopes: ["instance", "repository"],
	merge: "replace",
	defaultValue: 60_000,
	schema: {
		parse(value) {
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value <= 0 ||
				value > 2_147_483_647
			) {
				throw new Error(
					"Git timeout must be a positive integer of at most 2147483647 milliseconds",
				);
			}
			return value;
		},
	},
	form: {
		label: "Commit-message Git timeout (milliseconds)",
		group: "Implementation",
		control: "number",
		description: "Deadline per Git inspection command. Defaults to 60000 ms (60 seconds).",
	},
};

function model(key: string, label: string, group: string): SettingDefinition<string | null> {
	return {
		key,
		schemaVersion: 1,
		scopes: ["instance", "repository"],
		merge: "replace",
		defaultValue: null,
		schema: {
			parse(value) {
				if (value === null || (typeof value === "string" && value.length > 0)) return value;
				throw new Error("Choose a model profile or inherit the runtime default");
			},
		},
		form: {
			label,
			group,
			control: "model",
			description: "Used by future steps unless the process has an explicit model choice.",
		},
	};
}

/** @public */
export const codingSettings: ScopedSettingsDeclaration = {
	settings: [
		model("coding.planning_model", "Planning model", "Planning"),
		model("coding.implementation_model", "Implementation model", "Implementation"),
		model("coding.review_model", "Review model", "Review"),
		commitMessageGitTimeout,
	],
	purposes: Object.entries(codingPurposes).map(([name, id]) => ({
		id,
		label: name,
		modelSettingKey: `coding.${name}_model`,
		...(name === "implementation" ? { settingKeys: [commitMessageGitTimeout.key] } : {}),
	})),
};
