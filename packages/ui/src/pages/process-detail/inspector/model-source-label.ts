const labels: Record<string, string> = {
	instance: "Instance override",
	instance_turn_config: "Instance override",
	process_config_turn: "Configured step model",
	instance_default: "Inherits instance default",
	scoped_purpose_default: "Scoped purpose default",
	process_config_default: "Inherits process default",
	none: "Not configured",
	process_config: "Configured step model",
	default: "Inherits the default",
	catalog_default: "Catalog default",
	marked_default: "Automatic · default candidate",
	automatic: "Automatic · cost and profile ID",
	fixed_purpose: "Fixed system model",
};

/** @internal */
export function modelSourceLabel(source: string): string {
	return labels[source] ?? source;
}
