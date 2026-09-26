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
export const repositoryInstructions: SettingDefinition<string> = {
	key: "coding.repository_instructions",
	schemaVersion: 1,
	scopes: ["instance", "repository"],
	merge: "instructions",
	defaultValue: "",
	schema: {
		parse(value) {
			if (typeof value !== "string") throw new Error("Instructions must be text");
			return value;
		},
	},
	form: {
		label: "Repository instructions",
		group: "Instructions",
		control: "textarea",
		description:
			"Included in planning, implementation, and review. Use repository-specific guidance; credentials belong in provider configuration.",
	},
};

/** @public */
export const codingSettings: ScopedSettingsDeclaration = {
	settings: [
		model("coding.planning_model", "Planning model", "Planning"),
		model("coding.implementation_model", "Implementation model", "Implementation"),
		model("coding.review_model", "Review model", "Review"),
		repositoryInstructions,
	],
	purposes: Object.entries(codingPurposes).map(([name, id]) => ({
		id,
		label: name,
		modelSettingKey: `coding.${name}_model`,
		instructionSettingKeys: [repositoryInstructions.key],
	})),
};
