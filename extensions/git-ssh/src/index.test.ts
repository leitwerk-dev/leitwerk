import { describe, expect, it } from "vitest";
import { parseProfiles } from "./index.js";

const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

describe("git ssh profiles", () => {
	it("parses pinned profiles without exposing them through a catalog", () => {
		const profiles = parseProfiles({
			credentials: { default: { private_key: key, known_hosts: "git.example ssh-ed25519 AAAA" } },
		});
		expect(profiles.get("default")).toEqual({
			privateKey: key,
			knownHosts: "git.example ssh-ed25519 AAAA",
		});
	});

	it("requires a key and pinned hosts", () => {
		expect(() =>
			parseProfiles({ credentials: { bad: { private_key: key, known_hosts: "" } } }),
		).toThrow("pinned known_hosts");
		expect(() =>
			parseProfiles({
				credentials: { bad: { private_key: "nope", known_hosts: "git.example ssh-ed25519 AAAA" } },
			}),
		).toThrow("OpenSSH private key");
	});
});
