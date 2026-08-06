export interface TelegramExtensionConfig {
	enabled: boolean;
	botToken: string;
	allowUserIds: readonly number[];
	delivery: { forumChatId: string };
	markdown: { maxChars: number };
	topicTitleTemplate: string;
	actionModelSelection: { enabled: boolean };
	allowedModelProfileIds: readonly string[];
}

export type TelegramConfigResult =
	| { ok: true; config: TelegramExtensionConfig }
	| { ok: false; errors: readonly string[] };

interface RawTelegramConfig {
	enabled?: unknown;
	bot_token?: unknown;
	bot_token_env?: unknown;
	allow_user_ids?: unknown;
	delivery?: unknown;
	markdown?: unknown;
	topic_title_template?: unknown;
	action_model_selection?: unknown;
	allowed_model_profile_ids?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUserIds(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.map((entry) =>
					typeof entry === "number" ? entry : typeof entry === "string" ? Number(entry) : NaN,
				)
				.filter(Number.isSafeInteger),
		),
	];
}

function readInlineToken(raw: RawTelegramConfig): string {
	return typeof raw.bot_token === "string" ? raw.bot_token.trim() : "";
}

function readToken(raw: RawTelegramConfig): string {
	const envName = typeof raw.bot_token_env === "string" ? raw.bot_token_env.trim() : "";
	return envName ? (process.env[envName]?.trim() ?? readInlineToken(raw)) : readInlineToken(raw);
}

function normalizeAllowedModelProfileIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
}

export function normalizeTelegramConfig(rawValue: unknown): TelegramConfigResult {
	const raw = (isRecord(rawValue) ? rawValue : {}) as RawTelegramConfig;
	const delivery = isRecord(raw.delivery) ? raw.delivery : {};
	const markdown = isRecord(raw.markdown) ? raw.markdown : {};
	const actionModelSelection = isRecord(raw.action_model_selection)
		? raw.action_model_selection
		: {};
	const config: TelegramExtensionConfig = {
		enabled: raw.enabled === true,
		botToken: readToken(raw),
		allowUserIds: normalizeUserIds(raw.allow_user_ids),
		delivery: {
			forumChatId: typeof delivery.forum_chat_id === "string" ? delivery.forum_chat_id.trim() : "",
		},
		markdown: {
			maxChars:
				typeof markdown.max_chars === "number" && Number.isSafeInteger(markdown.max_chars)
					? Math.min(Math.max(markdown.max_chars, 500), 4096)
					: 3900,
		},
		topicTitleTemplate:
			typeof raw.topic_title_template === "string" && raw.topic_title_template.trim()
				? raw.topic_title_template.trim()
				: "{title} · {shortId}",
		actionModelSelection: {
			enabled: actionModelSelection.enabled !== false,
		},
		allowedModelProfileIds: normalizeAllowedModelProfileIds(raw.allowed_model_profile_ids),
	};

	if (!config.enabled) return { ok: true, config };

	const errors: string[] = [];
	if (!config.botToken)
		errors.push("extensions.telegram requires bot_token_env or bot_token when enabled");
	if (config.allowUserIds.length === 0) {
		errors.push("extensions.telegram.allow_user_ids must contain at least one Telegram user id");
	}
	if (!config.delivery.forumChatId) {
		errors.push("extensions.telegram.delivery.forum_chat_id is required for forum topic delivery");
	}
	return errors.length ? { ok: false, errors } : { ok: true, config };
}
