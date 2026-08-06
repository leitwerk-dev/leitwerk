import {
	BUILT_IN_COMMIT_MESSAGE_RULES,
	type CommitMessageProjectMetadata,
} from "@leitwerk-dev/process-sdk";
import type { CommitMessageConfig } from "./config/config-types.js";

export function normalizeRepositoryLocator(locator: string): string {
	return locator.trim().replace(/\/+$/, "");
}

export function resolveCommitMessageMetadata(
	repoLocator: string,
	config?: CommitMessageConfig,
): CommitMessageProjectMetadata {
	const normalizedLocator = normalizeRepositoryLocator(repoLocator);
	const override = Object.entries(config?.repositories ?? {}).find(
		([locator]) => normalizeRepositoryLocator(locator) === normalizedLocator,
	)?.[1];
	const templateId = override ?? config?.default_template ?? null;
	return {
		templateId,
		rules:
			(templateId ? config?.templates[templateId]?.rules : undefined) ??
			BUILT_IN_COMMIT_MESSAGE_RULES,
	};
}
