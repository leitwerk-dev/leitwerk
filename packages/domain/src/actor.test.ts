import { describe, expect, it } from "vitest";
import {
	normalizeActor,
	parseActorOrSystem,
	SERIALIZED_SYSTEM_ACTOR,
	serializeActor,
} from "./actor.js";
import { type Actor, SYSTEM_ACTOR } from "./domain-model.js";

describe("actor normalization", () => {
	it("keeps a well-formed user actor and drops unknown fields", () => {
		const actor = normalizeActor({
			id: "identity:alice",
			kind: "user",
			provider: "identity",
			displayName: "Alice",
			extra: "ignored",
		});
		expect(actor).toEqual({
			id: "identity:alice",
			kind: "user",
			provider: "identity",
			displayName: "Alice",
		});
	});

	it("returns null when no stable id is present", () => {
		expect(normalizeActor({ kind: "user", provider: "identity" })).toBeNull();
		expect(normalizeActor({ id: "   ", kind: "user", provider: null })).toBeNull();
		expect(normalizeActor(null)).toBeNull();
		expect(normalizeActor("identity:alice")).toBeNull();
	});

	it("falls back to a system kind while preserving extension-owned providers", () => {
		expect(normalizeActor({ id: "x", kind: "robot", provider: "github" })).toEqual({
			id: "x",
			kind: "system",
			provider: "github",
		});
	});

	it("omits a blank display name", () => {
		expect(
			normalizeActor({ id: "chat", kind: "channel", provider: "chat", displayName: "  " }),
		).toEqual({
			id: "chat",
			kind: "channel",
			provider: "chat",
		});
	});
});

describe("actor serialization round-trips", () => {
	it("serializes and parses an actor without losing fields", () => {
		const actor: Actor = {
			id: "codehost:bob",
			kind: "user",
			provider: "codehost",
			displayName: "Bob",
		};
		expect(parseActorOrSystem(serializeActor(actor))).toEqual(actor);
	});

	it("exposes a canonical serialized system actor that round-trips", () => {
		expect(parseActorOrSystem(SERIALIZED_SYSTEM_ACTOR)).toEqual(SYSTEM_ACTOR);
		expect(JSON.parse(SERIALIZED_SYSTEM_ACTOR)).toEqual({
			id: "system",
			kind: "system",
			provider: null,
		});
	});
});

describe("parseActorOrSystem fallbacks", () => {
	it("returns the system actor for missing or empty values", () => {
		expect(parseActorOrSystem(null)).toEqual(SYSTEM_ACTOR);
		expect(parseActorOrSystem(undefined)).toEqual(SYSTEM_ACTOR);
		expect(parseActorOrSystem("")).toEqual(SYSTEM_ACTOR);
	});

	it("returns the system actor for malformed json (legacy backfill)", () => {
		expect(parseActorOrSystem("not json")).toEqual(SYSTEM_ACTOR);
		expect(parseActorOrSystem("{}")).toEqual(SYSTEM_ACTOR);
		expect(parseActorOrSystem('{"kind":"user"}')).toEqual(SYSTEM_ACTOR);
	});
});
