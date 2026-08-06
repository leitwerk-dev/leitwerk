import { type Actor, type ActorKind, SYSTEM_ACTOR } from "./domain-model.js";

const ACTOR_KINDS: readonly ActorKind[] = ["user", "channel", "system"];
const ACTOR_PROVIDERS: ReadonlyArray<NonNullable<Actor["provider"]>> = [
	"forgejo",
	"gitlab",
	"telegram",
];

function isActorKind(value: unknown): value is ActorKind {
	return typeof value === "string" && (ACTOR_KINDS as readonly string[]).includes(value);
}

function normalizeProvider(value: unknown): Actor["provider"] {
	if (typeof value !== "string") {
		return null;
	}
	return (ACTOR_PROVIDERS as readonly string[]).includes(value)
		? (value as NonNullable<Actor["provider"]>)
		: null;
}

/**
 * Builds a validated `Actor`, dropping unknown fields and falling back to
 * defaults for invalid kind/provider. Returns `null` when no stable id is
 * present so callers can decide on a fallback actor.
 */
export function normalizeActor(value: unknown): Actor | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const candidate = value as Record<string, unknown>;
	const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
	if (id === "") {
		return null;
	}
	const kind = isActorKind(candidate.kind) ? candidate.kind : "system";
	const provider = normalizeProvider(candidate.provider);
	const displayName =
		typeof candidate.displayName === "string" && candidate.displayName.trim() !== ""
			? candidate.displayName
			: undefined;
	return {
		id,
		kind,
		provider,
		...(displayName !== undefined ? { displayName } : {}),
	};
}

/** Serializes an `Actor` to a stable JSON string for durable storage. */
export function serializeActor(actor: Actor): string {
	return JSON.stringify({
		id: actor.id,
		kind: actor.kind,
		provider: actor.provider,
		...(actor.displayName !== undefined ? { displayName: actor.displayName } : {}),
	});
}

/**
 * Parses a durable actor JSON value, falling back to `SYSTEM_ACTOR` when the
 * stored value is missing or malformed. Used when reading legacy rows that
 * predate actor attribution.
 */
export function parseActorOrSystem(value: string | null | undefined): Actor {
	if (value === null || value === undefined || value.trim() === "") {
		return SYSTEM_ACTOR;
	}
	try {
		return normalizeActor(JSON.parse(value)) ?? SYSTEM_ACTOR;
	} catch {
		return SYSTEM_ACTOR;
	}
}

/** Canonical serialized form of `SYSTEM_ACTOR`, used as the durable default. */
export const SERIALIZED_SYSTEM_ACTOR = serializeActor(SYSTEM_ACTOR);
