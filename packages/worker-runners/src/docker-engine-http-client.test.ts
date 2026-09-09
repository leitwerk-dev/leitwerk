import { describe, expect, it } from "vitest";
import { parseDockerEngineSocket } from "./docker-engine-http-client.js";

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
