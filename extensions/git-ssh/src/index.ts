import {
	coreHostCapabilities,
	type GitSshCredentialMaterial,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";

export const manifest = { id: "git-ssh", version: "0.1.0" } as const;

function parseProfiles(raw: unknown): Map<string, GitSshCredentialMaterial> {
	const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const credentials =
		root.credentials && typeof root.credentials === "object"
			? (root.credentials as Record<string, unknown>)
			: {};
	const profiles = new Map<string, GitSshCredentialMaterial>();
	for (const [ref, value] of Object.entries(credentials)) {
		const profile = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		const privateKey = typeof profile.private_key === "string" ? profile.private_key.trim() : "";
		const knownHosts = typeof profile.known_hosts === "string" ? profile.known_hosts.trim() : "";
		if (!privateKey.includes("BEGIN OPENSSH PRIVATE KEY"))
			throw new Error(`Invalid git_ssh credential '${ref}': an OpenSSH private key is required`);
		const encodedBody = privateKey
			.split(/\r?\n/)
			.filter((line) => !line.startsWith("-----"))
			.join("");
		const decodedHeader = Buffer.from(encodedBody, "base64").subarray(0, 96).toString("latin1");
		if (/ENCRYPTED/.test(privateKey) || decodedHeader.includes("bcrypt"))
			throw new Error(
				`Invalid git_ssh credential '${ref}': encrypted keys requiring a passphrase are unsupported`,
			);
		const hostLines = knownHosts
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
		if (hostLines.length === 0 || hostLines.some((line) => line.split(/\s+/).length < 3))
			throw new Error(
				`Invalid git_ssh credential '${ref}': pinned known_hosts entries are required`,
			);
		profiles.set(ref, { privateKey, knownHosts });
	}
	return profiles;
}

const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		const profiles = parseProfiles(config);
		deps.repositoryCredentials.register({
			kind: "git_ssh",
			resolve: (ref) => profiles.get(ref) ?? null,
		});
	},
};

export { parseProfiles };
export default extension;
