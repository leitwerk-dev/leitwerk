import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const AGGREGATED_AGENTS_REL = "AGENTS.md";
const AGGREGATED_SKILLS_DIR_REL = path.join(".leitwerk", "skills");

type DefaultResourceLoaderConstructorOptions = ConstructorParameters<
	typeof DefaultResourceLoader
>[0];

type LeitwerkResourceLoaderOptions = Omit<
	DefaultResourceLoaderConstructorOptions,
	"cwd" | "agentDir" | "settingsManager"
>;

export interface ResourceLoaderOptions {
	systemPrompt?: string;
	appendSystemPrompt?: string;
}

const PI_EXTENSION_SUFFIXES = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

function managedExtensionPaths(root: string): string[] {
	if (!existsSync(root)) return [];
	const paths: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile() && PI_EXTENSION_SUFFIXES.has(path.extname(entry.name))) {
				paths.push(entryPath);
			}
		}
	};
	visit(root);
	return paths.sort((left, right) => left.localeCompare(right));
}

export async function buildLeitwerkResourceLoaderOptions(
	workspaceRoot: string,
	agentDir: string,
	options: ResourceLoaderOptions = {},
): Promise<LeitwerkResourceLoaderOptions> {
	const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
	const aggregatedAgentsPath = path.join(workspaceRoot, AGGREGATED_AGENTS_REL);
	const aggregatedSkillsDir = path.join(workspaceRoot, AGGREGATED_SKILLS_DIR_REL);
	const managedExtensionsDir = path.join(agentDir, "extensions");
	const managedSkillsDir = path.join(agentDir, "skills");
	const managedPromptsDir = path.join(agentDir, "prompts");
	return {
		// Disable cwd and ambient discovery. Only the immutable managed snapshot and
		// explicitly aggregated process-workspace inputs may reach Pi.
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: managedExtensionPaths(managedExtensionsDir),
		additionalSkillPaths: existsSync(managedSkillsDir) ? [managedSkillsDir] : [],
		additionalPromptTemplatePaths: existsSync(managedPromptsDir) ? [managedPromptsDir] : [],
		systemPrompt: options.systemPrompt,
		appendSystemPrompt: options.appendSystemPrompt ? [options.appendSystemPrompt] : undefined,
		skillsOverride(base) {
			if (!existsSync(aggregatedSkillsDir)) {
				return base;
			}
			const extra = loadSkillsFromDir({
				dir: aggregatedSkillsDir,
				source: "process-workspace",
			});
			return {
				skills: [...base.skills, ...extra.skills],
				diagnostics: [...base.diagnostics, ...extra.diagnostics],
			};
		},
		agentsFilesOverride(base) {
			if (!existsSync(aggregatedAgentsPath)) {
				return base;
			}
			const normalizedAggregatedAgentsPath = path.resolve(aggregatedAgentsPath);
			if (
				base.agentsFiles.some((file) => path.resolve(file.path) === normalizedAggregatedAgentsPath)
			) {
				return base;
			}
			return {
				agentsFiles: [
					...base.agentsFiles,
					{
						path: aggregatedAgentsPath,
						content: readFileSync(aggregatedAgentsPath, "utf8"),
					},
				],
			};
		},
	};
}
