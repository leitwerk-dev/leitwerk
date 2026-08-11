import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const forbidden = ["forgejo", "jira", "gitlab", "telegram", "woodpecker"];
const ignoredDirectories = new Set(["dist", "node_modules", ".turbo"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".svelte", ".sql", ".json", ".md"]);
const violations: string[] = [];

function visit(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) visit(filePath);
			continue;
		}
		if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
		const lines = readFileSync(filePath, "utf8").split("\n");
		for (const [index, line] of lines.entries()) {
			const normalized = line.toLowerCase();
			if (forbidden.some((name) => normalized.includes(name))) {
				violations.push(`${path.relative(process.cwd(), filePath)}:${index + 1}:${line.trim()}`);
			}
		}
	}
}

visit(path.join(process.cwd(), "packages"));
if (violations.length > 0) {
	console.error("Core packages must not name application integrations:\n");
	console.error(violations.join("\n"));
	process.exit(1);
}

console.info("Core integration-name boundary passed.");
