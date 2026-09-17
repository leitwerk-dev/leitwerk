import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { WorkerDockerRegistryCredential } from "@leitwerk-dev/worker-protocol";

/** Credentials live outside every process volume and session export root. */
export class DockerRegistryCredentials {
	#directory: string | undefined;
	#previousConfig: string | undefined;
	#buildxDirectory: string | undefined;
	#onExit = () => this.dispose();

	install(credentials: readonly WorkerDockerRegistryCredential[], dockerEnabled: boolean): void {
		this.dispose();
		if (!dockerEnabled) {
			if (credentials.length)
				throw new Error("Docker credentials require a Docker-enabled process");
			return;
		}
		const auths: Record<string, { auth: string }> = Object.create(null);
		for (const credential of credentials) {
			if (
				!credential ||
				typeof credential.registry !== "string" ||
				!/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/.test(credential.registry) ||
				typeof credential.username !== "string" ||
				!credential.username ||
				/[:\r\n\0]/.test(credential.username) ||
				typeof credential.password !== "string" ||
				!credential.password
			)
				throw new Error("Invalid Docker registry credentials");
			if (Object.hasOwn(auths, credential.registry))
				throw new Error("Duplicate Docker registry credentials");
			auths[credential.registry] = {
				auth: Buffer.from(`${credential.username}:${credential.password}`).toString("base64"),
			};
		}
		try {
			// Do not honor TMPDIR: it can point into retained process storage.
			this.#directory = mkdtempSync("/tmp/leitwerk-docker-auth-");
			chmodSync(this.#directory, 0o700);
			writeFileSync(`${this.#directory}/config.json`, JSON.stringify({ auths }), {
				mode: 0o600,
				flag: "wx",
			});
			this.#previousConfig = process.env.DOCKER_CONFIG;
			process.env.DOCKER_CONFIG = this.#directory;
			if (!process.env.BUILDX_CONFIG) {
				this.#buildxDirectory = mkdtempSync("/tmp/leitwerk-buildx-");
				chmodSync(this.#buildxDirectory, 0o700);
				process.env.BUILDX_CONFIG = this.#buildxDirectory;
			}
			process.once("exit", this.#onExit);
		} catch {
			this.dispose();
			throw new Error("Cannot materialize private Docker credentials");
		}
	}

	dispose(): void {
		process.off("exit", this.#onExit);
		if (this.#buildxDirectory) {
			if (process.env.BUILDX_CONFIG === this.#buildxDirectory) delete process.env.BUILDX_CONFIG;
			rmSync(this.#buildxDirectory, { recursive: true, force: true });
			this.#buildxDirectory = undefined;
		}
		if (!this.#directory) return;
		if (process.env.DOCKER_CONFIG === this.#directory) {
			if (this.#previousConfig === undefined) delete process.env.DOCKER_CONFIG;
			else process.env.DOCKER_CONFIG = this.#previousConfig;
		}
		rmSync(this.#directory, { recursive: true, force: true });
		this.#directory = undefined;
		this.#previousConfig = undefined;
	}
}
