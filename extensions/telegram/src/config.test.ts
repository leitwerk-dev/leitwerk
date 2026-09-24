import { afterEach, describe, expect, it } from "vitest";
import { normalizeTelegramConfig } from "./config.js";

const OLD_ENV = process.env.TELEGRAM_TEST_TOKEN;

afterEach(() => {
	if (OLD_ENV === undefined) {
		delete process.env.TELEGRAM_TEST_TOKEN;
	} else {
		process.env.TELEGRAM_TEST_TOKEN = OLD_ENV;
	}
});

describe("normalizeTelegramConfig", () => {
	it("is disabled by default", () => {
		const result = normalizeTelegramConfig(undefined);
		expect(result).toMatchObject({ ok: true, config: { enabled: false } });
	});

	it("resolves tokens from the configured environment variable", () => {
		process.env.TELEGRAM_TEST_TOKEN = " token ";
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token_env: "TELEGRAM_TEST_TOKEN",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
		});
		expect(result).toMatchObject({
			ok: true,
			config: { botToken: "token", allowUserIds: [123], delivery: { forumChatId: "-1001" } },
		});
	});

	it("supports literal bot tokens in leitwerk yaml", () => {
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token: " yaml-token ",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
		});
		expect(result).toMatchObject({ ok: true, config: { botToken: "yaml-token" } });
	});

	it("uses the environment token before the literal bot token when both are configured", () => {
		process.env.TELEGRAM_TEST_TOKEN = "env-token";
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token_env: "TELEGRAM_TEST_TOKEN",
			bot_token: "yaml-token",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
		});
		expect(result).toMatchObject({ ok: true, config: { botToken: "env-token" } });
	});

	it("falls back to a literal bot token when the configured environment variable is unset", () => {
		delete process.env.TELEGRAM_TEST_TOKEN;
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token_env: "TELEGRAM_TEST_TOKEN",
			bot_token: "yaml-token",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
		});
		expect(result).toMatchObject({ ok: true, config: { botToken: "yaml-token" } });
	});

	it("reports all required enabled-config errors", () => {
		const result = normalizeTelegramConfig({ enabled: true });
		expect(result).toMatchObject({
			ok: false,
			errors: expect.arrayContaining([
				expect.stringContaining("bot_token"),
				expect.stringContaining("allow_user_ids"),
				expect.stringContaining("forum_chat_id"),
			]),
		});
	});

	it("normalizes allowlisted user ids and clamps markdown length", () => {
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token: "token",
			allow_user_ids: ["123", 123, "not-a-number", 456],
			delivery: { forum_chat_id: "-1001" },
			markdown: { max_chars: 50_000 },
		});
		expect(result).toMatchObject({
			ok: true,
			config: { allowUserIds: [123, 456], markdown: { maxChars: 4096 } },
		});
	});

	it("defaults allowed_model_profile_ids to an empty array", () => {
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token: "token",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
		});
		expect(result).toMatchObject({ ok: true, config: { allowedModelProfileIds: [] } });
	});

	it("normalizes allowed_model_profile_ids with deduplication", () => {
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token: "token",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
			allowed_model_profile_ids: [
				" deepseek-v4-flash ",
				"deepseek-v4-pro",
				"deepseek-v4-flash",
				123,
				"",
			],
		});
		expect(result).toMatchObject({
			ok: true,
			config: { allowedModelProfileIds: ["deepseek-v4-flash", "deepseek-v4-pro"] },
		});
	});

	it("rejects non-array allowed_model_profile_ids as empty", () => {
		const result = normalizeTelegramConfig({
			enabled: true,
			bot_token: "token",
			allow_user_ids: [123],
			delivery: { forum_chat_id: "-1001" },
			allowed_model_profile_ids: "not-an-array",
		});
		expect(result).toMatchObject({ ok: true, config: { allowedModelProfileIds: [] } });
	});
});
