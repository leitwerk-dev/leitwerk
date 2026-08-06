import type { ResolvedWorkerImage, WorkerIsolation } from "@leitwerk-dev/worker-runners/types";
import type { LeitwerkConfig, WorkerRuntimeProfileConfig } from "./config/config-types.js";

/**
 * Per-component runtime profile selection input. `profile` is the component's
 * configured `worker_runtime_profile`, or `undefined` when it declares none.
 */
export interface ComponentRuntimeProfileSelection {
	component: string;
	profile?: string;
}

export interface RuntimeProfileSelectionInput {
	processId: string;
	/** `process_configs.<processId>.worker_runtime_profile`, if set. */
	processOverride?: string;
	/** Per-component profile selections for the process's projects. */
	componentProfiles: ComponentRuntimeProfileSelection[];
	/** Runner-specific default profile (`kubernetes.default_worker_runtime_profile` wins in Kubernetes mode). */
	defaultProfile?: string;
	/** Configured `worker_runtime_profiles` keyed by id. */
	profiles: Record<string, WorkerRuntimeProfileConfig>;
}

export type RuntimeProfileSelectionResult =
	| {
			ok: true;
			runtimeProfile: string;
			image: ResolvedWorkerImage;
			/** Nested-container isolation derived from the profile's `dind` mode. */
			isolation: WorkerIsolation;
	  }
	| { ok: false; error: string };

function trimToUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Selects the worker runtime profile for a process.
 *
 * Precedence (matching the Kubernetes plan so both runners agree):
 * 1. Process-level override wins.
 * 2. Otherwise inspect component profiles:
 *    - none declared → fall back to the configured default.
 *    - all components agree on one profile → use it.
 *    - components disagree → reject before the worker starts.
 * 3. The resolved profile id must exist in `worker_runtime_profiles`.
 *
 * Repository branch content never reaches this function; image authority lives
 * entirely in leitwerk config.
 */
export function selectWorkerRuntimeProfile(
	input: RuntimeProfileSelectionInput,
): RuntimeProfileSelectionResult {
	const override = trimToUndefined(input.processOverride);
	if (override) {
		return resolveProfileImage(override, input.profiles);
	}

	const declared = input.componentProfiles
		.map((entry) => ({ component: entry.component, profile: trimToUndefined(entry.profile) }))
		.filter(
			(entry): entry is { component: string; profile: string } => entry.profile !== undefined,
		);

	const distinct = new Set(declared.map((entry) => entry.profile));
	if (distinct.size > 1) {
		const summary = declared
			.map((entry) => `${entry.component}=${entry.profile}`)
			.sort()
			.join(", ");
		return {
			ok: false,
			error: `Process '${input.processId}' has conflicting component worker runtime profiles (${summary}); set process_configs.${input.processId}.worker_runtime_profile to resolve`,
		};
	}

	if (distinct.size === 1) {
		const [only] = distinct;
		return resolveProfileImage(only, input.profiles);
	}

	const fallback = trimToUndefined(input.defaultProfile);
	if (!fallback) {
		return {
			ok: false,
			error: `Process '${input.processId}' selects no worker runtime profile and no default worker runtime profile is configured`,
		};
	}
	return resolveProfileImage(fallback, input.profiles);
}

function resolveProfileImage(
	runtimeProfile: string,
	profiles: Record<string, WorkerRuntimeProfileConfig>,
): RuntimeProfileSelectionResult {
	const profile = profiles[runtimeProfile];
	if (!profile) {
		return {
			ok: false,
			error: `Unknown worker runtime profile '${runtimeProfile}'; configure it under worker_runtime_profiles`,
		};
	}
	return {
		ok: true,
		runtimeProfile,
		image: { reference: profile.image },
		isolation: profile.dind ? { dind: profile.dind } : { dind: false },
	};
}

/**
 * Builds {@link RuntimeProfileSelectionInput} from leitwerk config for a
 * process and the components it spans.
 */
export function buildRuntimeProfileSelectionInput(args: {
	config: LeitwerkConfig;
	processId: string;
	componentKeys: string[];
}): RuntimeProfileSelectionInput {
	const { config, processId, componentKeys } = args;
	const componentProfiles: ComponentRuntimeProfileSelection[] = componentKeys.map((component) => ({
		component,
		profile: config.components[component]?.worker_runtime_profile,
	}));
	return {
		processId,
		processOverride: config.process_configs?.[processId]?.worker_runtime_profile,
		componentProfiles,
		defaultProfile:
			config.workers.runner === "kubernetes"
				? (config.kubernetes?.default_worker_runtime_profile ??
					config.workers.default_runtime_profile)
				: config.workers.default_runtime_profile,
		profiles: config.worker_runtime_profiles ?? {},
	};
}
