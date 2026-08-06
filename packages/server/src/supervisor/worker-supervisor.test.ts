import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { createWorkerSupervisor } from "./worker-supervisor.js";

describe("createWorkerSupervisor", () => {
	it("requires the shared runner runtime dependency", () => {
		expect(typeof createWorkerSupervisor).toBe("function");
		expect(getDefaultConfig().workers.runner).toBe("docker");
	});
});
