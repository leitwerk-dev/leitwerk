import { describe, expect, it } from "vitest";
import { createDockerEngineHttpClient } from "./docker-engine-http-client.js";

const runSmoke = process.env.LEITWERK_DOCKER_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

describeSmoke("DockerEngineHttpClient smoke", () => {
	it("starts and removes a worker-shaped container through the real daemon", async () => {
		const engine = createDockerEngineHttpClient({
			socket: process.env.LEITWERK_DOCKER_SOCKET ?? "unix:///var/run/docker.sock",
		});
		const image = process.env.LEITWERK_DOCKER_SMOKE_IMAGE;
		if (!image)
			throw new Error("Set LEITWERK_DOCKER_SMOKE_IMAGE to a locally available worker image");
		const { id } = await engine.createContainer({
			name: `leitwerk-smoke-${Date.now()}`,
			image,
			env: ["LEITWERK_SMOKE=1"],
			labels: { "leitwerk.dev/smoke": "docker-engine-http-client" },
			mounts: [],
			networkMode: "bridge",
			privileged: false,
		});
		try {
			await engine.startContainer(id);
			const inspect = await engine.inspectContainer(id);
			expect(inspect.id).toBe(id);
		} finally {
			await engine.stopContainer(id, { timeoutSeconds: 1 }).catch(() => {});
			await engine.removeContainer(id, { force: true }).catch(() => {});
		}
	});
});
