import type { ProcessLaunchConfigurationView } from "./api.js";

/** Empty launch configuration read model for process-detail test fixtures. */
export function emptyLaunchConfiguration(): ProcessLaunchConfigurationView {
	return {
		launcherId: null,
		launcherLabel: null,
		launcherSchemaTitle: null,
		paramsParseError: null,
		parameters: [],
		projects: [],
	};
}
