import { describe, expect, it } from "vitest";
import {
	canonicalJsonEqual,
	canonicalJsonStringify,
	parsePiResourceManifest,
} from "./pi-resource-manifest.js";

function manifest() {
	return {
		schemaVersion: 1,
		model: {
			profileId: "profile",
			providerId: "provider",
			modelId: "model",
			thinkingLevel: "off",
		},
		providerOptions: { account: "team" },
		providerWorkerConfig: { version: 1, value: { endpoint: "https://example.invalid" } },
		declaredCredentialPaths: ["auth.json"],
		compatibility: { workerApiVersion: "worker-v1", piVersion: "pi-v1" },
		provenance: [
			{
				kind: "generated",
				ownerExtensionId: null,
				packageName: null,
				snapshotPath: "settings.json",
				sha256: "a".repeat(64),
				size: 10,
			},
		],
	} as const;
}

describe("Pi resource manifest", () => {
	it("parses the shared generated.json contract", () => {
		expect(parsePiResourceManifest(manifest())).toEqual(manifest());
	});

	it("rejects unknown metadata and overlapping paths", () => {
		expect(() => parsePiResourceManifest({ ...manifest(), entrypoints: [] })).toThrow(
			/resource manifest schema/,
		);
		expect(() =>
			parsePiResourceManifest({
				...manifest(),
				declaredCredentialPaths: ["settings.json"],
			}),
		).toThrow(/overlaps immutable snapshot content/);
	});

	it("provides canonical serialization and equality", () => {
		expect(canonicalJsonStringify({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
		expect(canonicalJsonEqual({ first: 1, second: 2 }, { second: 2, first: 1 })).toBe(true);
	});
});
