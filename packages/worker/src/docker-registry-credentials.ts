import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	dockerRegistryCredentialSchema,
	type WorkerDockerRegistryCredential,
} from "@leitwerk-dev/worker-protocol";
import { is } from "valibot";

/** Credentials live outside every process volume and session export root. */
export class DockerRegistryCredentials {
	#directory: string | undefined;
	#previousConfig: string | undefined;
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
			if (!is(dockerRegistryCredentialSchema, credential))
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
			mkdirSync(`${this.#directory}/auth`, { mode: 0o700 });
			writeFileSync(`${this.#directory}/auth/config.json`, JSON.stringify({ auths }), {
				mode: 0o600,
				flag: "wx",
			});
			this.#previousConfig = process.env.DOCKER_CONFIG;
			process.env.DOCKER_CONFIG = `${this.#directory}/auth`;
			if (!process.env.BUILDX_CONFIG) {
				mkdirSync(`${this.#directory}/buildx`, { mode: 0o700 });
				process.env.BUILDX_CONFIG = `${this.#directory}/buildx`;
			}
			process.once("exit", this.#onExit);
		} catch {
			this.dispose();
			throw new Error("Cannot materialize private Docker credentials");
		}
	}

	dispose(): void {
		process.off("exit", this.#onExit);
		if (!this.#directory) return;
		if (process.env.BUILDX_CONFIG === `${this.#directory}/buildx`) delete process.env.BUILDX_CONFIG;
		if (process.env.DOCKER_CONFIG === `${this.#directory}/auth`) {
			if (this.#previousConfig === undefined) delete process.env.DOCKER_CONFIG;
			else process.env.DOCKER_CONFIG = this.#previousConfig;
		}
		rmSync(this.#directory, { recursive: true, force: true });
		this.#directory = undefined;
		this.#previousConfig = undefined;
	}
}
