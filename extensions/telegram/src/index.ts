import {
	coreHostCapabilities,
	createCapabilityToken,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { TelegramBridge } from "./bridge.js";
import { normalizeTelegramConfig } from "./config.js";
import { GrammyTelegramClient } from "./grammy-telegram-client.js";
import type { TelegramClient } from "./types.js";

export const telegramClientToken = createCapabilityToken<TelegramClient>("telegram:client");

export const manifest = {
	id: "telegram",
	version: "0.1.0",
} as const;

const telegramExtension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, rawConfig) {
		const configResult = normalizeTelegramConfig(rawConfig);
		if (!configResult.ok) {
			throw new Error(`Invalid telegram extension config:\n${configResult.errors.join("\n")}`);
		}
		const config = configResult.config;
		if (!config.enabled) {
			return;
		}

		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) {
			return;
		}

		const providedClient = api.get(telegramClientToken);
		const client = Array.isArray(providedClient) ? providedClient[0] : providedClient;
		const telegramClient =
			client ??
			new GrammyTelegramClient({
				botToken: config.botToken,
				logger: api.logger,
			});
		if (!client) {
			api.provide(telegramClientToken, telegramClient);
		}

		const bridge = new TelegramBridge({
			config,
			deps,
			client: telegramClient,
			logger: api.logger,
		});
		bridge.register(api.events);
		api.onStart(() => bridge.start());
		api.onStop(() => bridge.stop());
	},
};

export default telegramExtension;
export { TELEGRAM_ACTOR } from "./actor.js";
export * from "./bridge.js";
export * from "./config.js";
export * from "./fake-telegram-client.js";
export * from "./form-session.js";
export * from "./launch-session.js";
export * from "./markdown-html.js";
export * from "./process-thread-store.js";
export * from "./topic-title.js";
export type * from "./types.js";
