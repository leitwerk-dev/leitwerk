import { describe, expect, it } from "vitest";
import type { DockerContainerSpec } from "./docker-engine-client.js";
import {
	dockerEngineRequestMapping,
	parseDockerEngineSocket,
} from "./docker-engine-http-client.js";

describe("parseDockerEngineSocket", () => {
	it("parses unix:// Docker socket URLs", () => {
		expect(parseDockerEngineSocket("unix:///var/run/docker.sock")).toEqual({
			socketPath: "/var/run/docker.sock",
		});
	});

	it("accepts absolute paths as unix socket shorthand", () => {
		expect(parseDockerEngineSocket("/var/run/docker.sock")).toEqual({
			socketPath: "/var/run/docker.sock",
		});
	});

	it("rejects unsupported socket schemes", () => {
		expect(() => parseDockerEngineSocket("npipe:////./pipe/docker_engine")).toThrow(
			/Unsupported docker\.socket/,
		);
	});
});

describe("dockerEngineRequestMapping", () => {
	it("maps createContainer to Docker Engine create payload", () => {
		const spec: DockerContainerSpec = {
			name: "orch-worker",
			image: "example/worker:latest",
			env: ["A=B"],
			command: ["node", "/app/helper.js"],
			labels: { "leitwerk.dev/component": "worker" },
			mounts: [
				{ source: "/host/state", target: "/state" },
				{ source: "/host/ca.pem", target: "/leitwerk/server-ca.pem", readOnly: true },
			],
			networkMode: "leitwerk",
			privileged: true,
			runtime: "sysbox-runc",
			anonymousVolumes: ["/var/lib/docker"],
			nanoCpus: 1_000_000_000,
			memoryBytes: 512 * 1024 * 1024,
		};

		const mapped = dockerEngineRequestMapping("createContainer", [spec]);

		expect(mapped.method).toBe("POST");
		expect(mapped.path).toBe("/containers/create");
		expect(mapped.query).toEqual({ name: "orch-worker" });
		expect(mapped.body).toMatchObject({
			Image: "example/worker:latest",
			Env: ["A=B"],
			Cmd: ["node", "/app/helper.js"],
			Labels: { "leitwerk.dev/component": "worker" },
			Volumes: { "/var/lib/docker": {} },
			HostConfig: {
				NetworkMode: "leitwerk",
				Privileged: true,
				Runtime: "sysbox-runc",
				NanoCpus: 1_000_000_000,
				Memory: 512 * 1024 * 1024,
				Mounts: [
					{ Type: "bind", Source: "/host/state", Target: "/state", ReadOnly: false },
					{
						Type: "bind",
						Source: "/host/ca.pem",
						Target: "/leitwerk/server-ca.pem",
						ReadOnly: true,
					},
				],
			},
		});
	});

	it("maps list label filters as Docker Engine JSON filters", () => {
		const mapped = dockerEngineRequestMapping("listContainers", [{ labels: { a: "b", c: "d" } }]);
		expect(mapped).toEqual({
			method: "GET",
			path: "/containers/json",
			query: { filters: JSON.stringify({ label: ["a=b", "c=d"] }) },
		});
	});
});
