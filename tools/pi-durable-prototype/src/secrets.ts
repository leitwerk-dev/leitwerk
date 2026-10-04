/** Server-side credential boundary. Never includes a rejected value in an error. @internal */
export class SecretBoundary {
	constructor(private readonly secrets: readonly string[]) {
		if (secrets.some((secret) => secret.length < 16))
			throw new Error("Use nontrivial test credentials");
	}
	assertPublic(value: unknown): void {
		const serialized = JSON.stringify(value);
		if (
			this.secrets.some((secret) =>
				[secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)].some((form) =>
					serialized?.includes(form),
				),
			)
		) {
			throw new Error("Credential boundary rejected outbound data");
		}
	}
}
