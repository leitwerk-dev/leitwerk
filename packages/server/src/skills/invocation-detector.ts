import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function skillIdFromManagedPath(
	value: unknown,
	managedAgentDir: { instanceId: string; leaseId: string },
): string | null {
	if (typeof value !== "string") return null;
	const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
	const suffix = segments.slice(-5);
	if (
		suffix[0] !== managedAgentDir.instanceId ||
		suffix[1] !== managedAgentDir.leaseId ||
		suffix[2] !== "skills" ||
		suffix[4] !== "SKILL.md"
	) {
		return null;
	}
	return suffix[3] ?? null;
}

export interface DetectedSkillInvocation {
	skillId: string;
	invokedAt: string;
}

export async function detectSkillInvocations(
	snapshotPath: string,
	options: {
		since?: string;
		managedAgentDir: { instanceId: string; leaseId: string };
	},
): Promise<DetectedSkillInvocation[]> {
	const invocations = new Map<string, DetectedSkillInvocation>();
	const sinceTimestamp = options.since ? Date.parse(options.since) : null;
	const lines = createInterface({
		input: createReadStream(snapshotPath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		if (!line.trim()) continue;
		const entry = asRecord(JSON.parse(line));
		const invokedAt = typeof entry?.timestamp === "string" ? entry.timestamp : null;
		const invokedTimestamp = invokedAt ? Date.parse(invokedAt) : Number.NaN;
		if (!invokedAt || !Number.isFinite(invokedTimestamp)) continue;
		if (sinceTimestamp !== null && invokedTimestamp < sinceTimestamp) continue;
		const message = asRecord(entry?.message);
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const value of message.content) {
			const block = asRecord(value);
			if (block?.type !== "toolCall" || block.name !== "read") continue;
			const args = asRecord(block.arguments);
			const skillId = skillIdFromManagedPath(
				args?.path ?? args?.file_path,
				options.managedAgentDir,
			);
			if (skillId && !invocations.has(skillId)) {
				invocations.set(skillId, { skillId, invokedAt });
			}
		}
	}
	return [...invocations.values()];
}
