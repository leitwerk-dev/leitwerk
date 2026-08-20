import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { SkillCatalogService } from "../skills/catalog-service.js";
import { registerSkillRoutes } from "./skills.js";

function service(): SkillCatalogService {
	return {
		list: vi.fn(() => ({ repositories: [], availableSkills: [], installedSkills: [] })),
		refresh: vi.fn(async () => ({ repositories: [], availableSkills: [], installedSkills: [] })),
		detail: vi.fn(() => null),
		installedDetail: vi.fn(() => null),
		register: vi.fn(() => "skillrev_1"),
		remove: vi.fn(() => true),
	};
}

describe("skill routes", () => {
	it("uses separate remote and installed resources", async () => {
		const app = Fastify({ logger: false });
		const catalog = service();
		registerSkillRoutes(app, { skillCatalog: catalog });

		const refresh = await app.inject({ method: "POST", url: "/api/skills/refresh" });
		const register = await app.inject({
			method: "POST",
			url: "/api/skills/available/shared/review/register",
		});
		const remove = await app.inject({
			method: "DELETE",
			url: "/api/skills/installed/review",
		});

		expect(refresh.statusCode).toBe(200);
		expect(catalog.refresh).toHaveBeenCalledOnce();
		expect(register.statusCode).toBe(200);
		expect(catalog.register).toHaveBeenCalledWith("shared", "review");
		expect(remove.statusCode).toBe(204);
		expect(catalog.remove).toHaveBeenCalledWith("review");
		await app.close();
	});

	it("returns conflicts for ambiguous registration", async () => {
		const app = Fastify({ logger: false });
		const catalog = service();
		vi.mocked(catalog.register).mockImplementation(() => {
			throw new Error("Skill 'review' has conflicting repository candidates");
		});
		registerSkillRoutes(app, { skillCatalog: catalog });

		const response = await app.inject({
			method: "POST",
			url: "/api/skills/available/shared/review/register",
		});

		expect(response.statusCode).toBe(409);
		await app.close();
	});
});
