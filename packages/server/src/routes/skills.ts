import type { FastifyInstance } from "fastify";
import type { SkillCatalogService } from "../skills/catalog-service.js";

export interface SkillRouteDeps {
	skillCatalog: SkillCatalogService;
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteDeps): void {
	app.get("/api/skills", async () => deps.skillCatalog.list());
	app.post("/api/skills/refresh", async () => deps.skillCatalog.refresh());
	app.get<{ Params: { skillId: string } }>(
		"/api/skills/installed/:skillId",
		async (request, reply) => {
			const skill = deps.skillCatalog.installedDetail(request.params.skillId);
			if (!skill) return reply.code(404).send({ error: "Installed skill was not found" });
			return { skill };
		},
	);
	app.get<{ Params: { repositoryId: string; skillId: string } }>(
		"/api/skills/available/:repositoryId/:skillId",
		async (request, reply) => {
			const skill = deps.skillCatalog.detail(request.params.repositoryId, request.params.skillId);
			if (!skill) return reply.code(404).send({ error: "Skill was not found" });
			return { skill };
		},
	);
	app.post<{ Params: { repositoryId: string; skillId: string } }>(
		"/api/skills/available/:repositoryId/:skillId/register",
		async (request, reply) => {
			try {
				const revisionId = deps.skillCatalog.register(
					request.params.repositoryId,
					request.params.skillId,
				);
				return { revisionId };
			} catch (error) {
				const message = error instanceof Error ? error.message : "Skill could not be registered";
				return reply.code(message.includes("conflicting") ? 409 : 404).send({ error: message });
			}
		},
	);
	app.delete<{ Params: { skillId: string } }>(
		"/api/skills/installed/:skillId",
		async (request, reply) => {
			if (!deps.skillCatalog.remove(request.params.skillId)) {
				return reply.code(409).send({
					error: "Skill is not installed from a repository or is already unavailable",
				});
			}
			return reply.code(204).send();
		},
	);
}
