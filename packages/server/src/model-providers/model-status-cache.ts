import type { ProviderAvailability, ProviderModelStatus } from "@leitwerk-dev/process-sdk";
import type { ModelProfileSnapshot } from "@leitwerk-dev/protocol";
import { positiveBound, validateCredentialStatus, withTimeout } from "./provider-boundary-utils.js";
import type {
	ModelProviderCredentialStatusResolver,
	ModelProviderRegistry,
	RegisteredModelProvider,
} from "./registry.js";

const DEFAULT_STATUS_TTL_MS = 30_000;
const DEFAULT_STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_STATUS_PROFILES = 512;
const MAX_SAFE_REASON_LENGTH = 500;

export interface CachedModelProfileStatus {
	readonly profileId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly availability: ProviderAvailability;
	readonly safeReason?: string;
	readonly checkedAt: string | null;
	readonly expiresAt: string | null;
}

export interface ModelAvailabilityTransition {
	readonly profileId: string;
	readonly from: ProviderAvailability;
	readonly to: ProviderAvailability;
}

export interface ModelStatusCacheSnapshot {
	readonly revision: number;
	readonly capturedAt: string;
	readonly profiles: readonly CachedModelProfileStatus[];
	/** Present only on the refresh result that observed the transition. */
	readonly availabilityTransitions: readonly ModelAvailabilityTransition[];
}

export interface ModelStatusCache {
	refresh(): Promise<ModelStatusCacheSnapshot>;
	snapshot(): ModelStatusCacheSnapshot;
	get(profileId: string): CachedModelProfileStatus | null;
}

export interface CreateModelStatusCacheInput {
	readonly registry: ModelProviderRegistry;
	readonly modelProfiles: readonly ModelProfileSnapshot[];
	readonly credentialStatus: ModelProviderCredentialStatusResolver;
	readonly ttlMs?: number;
	readonly timeoutMs?: number;
	readonly maxProfiles?: number;
	readonly now?: () => Date;
}

function safeReason(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized === "" ? fallback : normalized.slice(0, MAX_SAFE_REASON_LENGTH);
}

function validateProviderStatuses(
	provider: RegisteredModelProvider,
	statuses: readonly ProviderModelStatus[],
): ReadonlyMap<string, ProviderModelStatus> {
	if (!Array.isArray(statuses)) {
		throw new Error(`Provider '${provider.id}' returned a non-array model status result`);
	}
	const byModel = new Map<string, ProviderModelStatus>();
	for (const status of statuses) {
		if (
			typeof status !== "object" ||
			status === null ||
			typeof status.modelId !== "string" ||
			status.modelId.trim() === "" ||
			!(["available", "unavailable", "stale"] as const).includes(status.availability)
		) {
			throw new Error(`Provider '${provider.id}' returned an invalid model status`);
		}
		if (byModel.has(status.modelId)) {
			throw new Error(
				`Provider '${provider.id}' returned duplicate status for model '${status.modelId}'`,
			);
		}
		byModel.set(status.modelId, {
			modelId: status.modelId,
			availability: status.availability,
			...(status.safeReason
				? { safeReason: safeReason(status.safeReason, "Provider reported the model unavailable") }
				: {}),
		});
	}
	return byModel;
}

/**
 * Keep a fixed, configured-profile status catalog. Refresh failures are safe,
 * bounded stale states; they never remove a configured profile from the UI.
 */
export function createModelStatusCache(input: CreateModelStatusCacheInput): ModelStatusCache {
	const ttlMs = positiveBound(input.ttlMs, DEFAULT_STATUS_TTL_MS, "Model status TTL");
	const timeoutMs = positiveBound(
		input.timeoutMs,
		DEFAULT_STATUS_TIMEOUT_MS,
		"Model status timeout",
	);
	const maxProfiles = positiveBound(
		input.maxProfiles,
		DEFAULT_MAX_STATUS_PROFILES,
		"Maximum cached model profiles",
	);
	if (input.modelProfiles.length > maxProfiles) {
		throw new Error(
			`Configured model profile count ${input.modelProfiles.length} exceeds cache bound ${maxProfiles}`,
		);
	}
	const profileIds = new Set<string>();
	for (const profile of input.modelProfiles) {
		if (profileIds.has(profile.id)) throw new Error(`Duplicate model profile id '${profile.id}'`);
		profileIds.add(profile.id);
		input.registry.require(profile.provider);
	}

	const now = input.now ?? (() => new Date());
	const orderedProfiles = [...input.modelProfiles];
	const profilesByProvider = Map.groupBy(orderedProfiles, (profile) => profile.provider);
	let revision = 0;
	let inFlight: Promise<ModelStatusCacheSnapshot> | null = null;
	let statuses = new Map<string, CachedModelProfileStatus>(
		orderedProfiles.map((profile) => [
			profile.id,
			{
				profileId: profile.id,
				providerId: profile.provider,
				modelId: profile.model_id,
				availability: "stale" as const,
				safeReason: "Model status has not been refreshed",
				checkedAt: null,
				expiresAt: null,
			},
		]),
	);

	function expire(at: Date): void {
		let changed = false;
		for (const [profileId, status] of statuses) {
			if (
				status.availability !== "stale" &&
				status.expiresAt !== null &&
				Date.parse(status.expiresAt) <= at.getTime()
			) {
				statuses.set(profileId, {
					...status,
					availability: "stale",
					safeReason: "Model status expired",
				});
				changed = true;
			}
		}
		if (changed) revision += 1;
	}

	function capture(
		at = now(),
		availabilityTransitions: readonly ModelAvailabilityTransition[] = [],
	): ModelStatusCacheSnapshot {
		expire(at);
		return {
			revision,
			capturedAt: at.toISOString(),
			profiles: orderedProfiles.map(
				(profile) => statuses.get(profile.id) as CachedModelProfileStatus,
			),
			availabilityTransitions,
		};
	}

	async function refreshProvider(
		provider: RegisteredModelProvider,
		profiles: readonly ModelProfileSnapshot[],
	): Promise<Map<string, Omit<CachedModelProfileStatus, "checkedAt" | "expiresAt">>> {
		let providerStatuses: ReadonlyMap<string, ProviderModelStatus> | null = null;
		let fallback: Pick<ProviderModelStatus, "availability" | "safeReason"> = {
			availability: "unavailable",
			safeReason: "Provider did not report model availability",
		};
		try {
			providerStatuses = await withTimeout(
				(async () => {
					const credentialStatus = validateCredentialStatus(
						await input.credentialStatus(provider),
						"Provider returned an invalid credential status",
					);
					if (!credentialStatus.available) return null;
					const statuses = await provider.definition.models({
						config: provider.config,
						credentialStatus,
						configuredModels: profiles.map((profile) => ({
							profileId: profile.id,
							modelId: profile.model_id,
						})),
					});
					return validateProviderStatuses(provider, statuses);
				})(),
				timeoutMs,
				"provider_status_timeout",
			);
			if (!providerStatuses) {
				fallback = {
					availability: "unavailable",
					safeReason: "Provider credentials are unavailable",
				};
			}
		} catch (error) {
			fallback = {
				availability: "stale",
				safeReason:
					error instanceof Error && error.message === "provider_status_timeout"
						? "Provider model status refresh timed out"
						: "Provider model status refresh failed",
			};
		}
		return new Map(
			profiles.map((profile) => {
				const status = providerStatuses?.get(profile.model_id) ?? fallback;
				return [
					profile.id,
					{
						profileId: profile.id,
						providerId: profile.provider,
						modelId: profile.model_id,
						...status,
					},
				];
			}),
		);
	}

	async function refresh(): Promise<ModelStatusCacheSnapshot> {
		if (inFlight) return inFlight;
		inFlight = (async () => {
			const refreshed = await Promise.all(
				[...profilesByProvider].map(([providerId, profiles]) =>
					refreshProvider(input.registry.require(providerId), profiles),
				),
			);
			const checked = now();
			const checkedAt = checked.toISOString();
			const expiresAt = new Date(checked.getTime() + ttlMs).toISOString();
			const next = new Map<string, CachedModelProfileStatus>();
			for (const providerStatuses of refreshed) {
				for (const [profileId, status] of providerStatuses) {
					next.set(profileId, { ...status, checkedAt, expiresAt });
				}
			}
			const transitions: ModelAvailabilityTransition[] = [];
			let policyChanged = false;
			for (const profile of orderedProfiles) {
				const previous = statuses.get(profile.id);
				const current = next.get(profile.id);
				if (!previous || !current) continue;
				if (previous.availability !== current.availability) {
					transitions.push({
						profileId: profile.id,
						from: previous.availability,
						to: current.availability,
					});
				}
				if (
					previous.availability !== current.availability ||
					(previous.safeReason ?? null) !== (current.safeReason ?? null)
				) {
					policyChanged = true;
				}
			}
			statuses = next;
			if (policyChanged) revision += 1;
			return capture(checked, transitions);
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	return {
		refresh,
		snapshot: () => capture(),
		get(profileId: string) {
			expire(now());
			return statuses.get(profileId) ?? null;
		},
	};
}
