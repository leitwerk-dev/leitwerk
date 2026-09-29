const labels: Record<string, string> = {
	instance: "Instance override",
	instance_turn_config: "Instance override",
	process_config_turn: "Configured step model",
	instance_default: "Inherits instance default",
	process_config_default: "Inherits process default",
	none: "Not configured",
	process_config: "Configured step model",
	default: "Inherits the default",
	catalog_default: "Catalog default",
};

/** @internal */
export function modelSourceLabel(source: string): string {
	return labels[source] ?? source;
}
