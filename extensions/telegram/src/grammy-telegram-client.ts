import type { ServerExtensionLogger } from "@leitwerk-dev/process-sdk";
import { Bot, InputFile } from "grammy";
import {
	BaseTelegramClientEventRegistrar,
	type TelegramCallbackUpdate,
	type TelegramClient,
	type TelegramForumTopicCreatedHandler,
	type TelegramForumTopicCreatedUpdate,
	type TelegramReplyMarkup,
	type TelegramSendFileInput,
	type TelegramSendMessageInput,
	type TelegramSentMessage,
	type TelegramTextUpdate,
	type TelegramUserRef,
} from "./types.js";

interface GrammyBotLike {
	api: {
		getUpdates(options: Record<string, unknown>): Promise<unknown[]>;
		createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number }>;
		editForumTopic(
			chatId: string,
			messageThreadId: number,
			options: { name: string },
		): Promise<unknown>;
		closeForumTopic(chatId: string, messageThreadId: number): Promise<unknown>;
		sendMessage(
			chatId: string,
			text: string,
			options?: Record<string, unknown>,
		): Promise<{ message_id: number }>;
		sendPhoto(
			chatId: string,
			photo: InputFile,
			options?: Record<string, unknown>,
		): Promise<{ message_id: number }>;
		sendDocument(
			chatId: string,
			document: InputFile,
			options?: Record<string, unknown>,
		): Promise<{ message_id: number }>;
		answerCallbackQuery(id: string, options?: Record<string, unknown>): Promise<unknown>;
	};
	on(filter: "message:text", handler: (ctx: GrammyTextContext) => void | Promise<void>): void;
	on(
		filter: "message:forum_topic_created",
		handler: (ctx: GrammyForumTopicContext) => void | Promise<void>,
	): void;
	on(
		filter: "message:forum_topic_closed",
		handler: (ctx: GrammyForumTopicContext) => void | Promise<void>,
	): void;
	on(
		filter: "callback_query:data",
		handler: (ctx: GrammyCallbackContext) => void | Promise<void>,
	): void;
	start(options?: Record<string, unknown>): Promise<void>;
	stop(): Promise<void>;
}

interface GrammyMessage {
	message_id: number;
	message_thread_id?: number;
	chat: { id: number | string };
	from?: { id: number; username?: string };
}

interface GrammyTextContext {
	message: GrammyMessage & { text: string };
}

interface GrammyForumTopicContext {
	message: GrammyMessage;
}

interface GrammyCallbackContext {
	callbackQuery: {
		id: string;
		from?: { id: number; username?: string };
		data: string;
		message?: {
			message_thread_id?: number;
			chat: { id: number | string };
		};
	};
}

function toTelegramReplyMarkup(markup: TelegramReplyMarkup | undefined) {
	if (!markup) return undefined;
	if (markup.inlineKeyboard) {
		return {
			inline_keyboard: markup.inlineKeyboard.map((row) =>
				row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
			),
		};
	}
	if (markup.forceReply) {
		return {
			force_reply: true,
			...(markup.inputFieldPlaceholder
				? { input_field_placeholder: markup.inputFieldPlaceholder }
				: {}),
			...(markup.selective !== undefined ? { selective: markup.selective } : {}),
		};
	}
	return undefined;
}

function toUserRef(value: { id: number; username?: string } | undefined): TelegramUserRef | null {
	return value ? { id: value.id, ...(value.username ? { username: value.username } : {}) } : null;
}

export class GrammyTelegramClient
	extends BaseTelegramClientEventRegistrar
	implements TelegramClient
{
	private readonly bot: GrammyBotLike;
	private startPromise: Promise<void> | null = null;
	private pollingPromise: Promise<void> | null = null;

	constructor(
		private readonly input: {
			botToken: string;
			botFactory?: (token: string) => GrammyBotLike;
			logger?: ServerExtensionLogger;
		},
	) {
		super();
		this.bot =
			input.botFactory?.(input.botToken) ?? (new Bot(input.botToken) as unknown as GrammyBotLike);
		this.bot.on("message:text", (ctx) => this.dispatchText(ctx));
		this.bot.on("message:forum_topic_created", (ctx) =>
			this.dispatchForumTopic(ctx, this.forumTopicCreatedHandlers),
		);
		this.bot.on("message:forum_topic_closed", (ctx) =>
			this.dispatchForumTopic(ctx, this.forumTopicClosedHandlers),
		);
		this.bot.on("callback_query:data", (ctx) => this.dispatchCallback(ctx));
	}

	async start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		const starting = this.startPolling();
		this.startPromise = starting;
		try {
			await starting;
		} catch (error) {
			if (this.startPromise === starting) this.startPromise = null;
			throw error;
		}
	}

	private async startPolling(): Promise<void> {
		const allowedUpdates = ["message", "callback_query"];
		await this.bot.api.getUpdates({
			allowed_updates: allowedUpdates,
			limit: 1,
			offset: -1,
			timeout: 0,
		});

		let startupSettled = false;
		let resolveStartup: (() => void) | undefined;
		let rejectStartup: ((error: unknown) => void) | undefined;
		const startup = new Promise<void>((resolve, reject) => {
			resolveStartup = resolve;
			rejectStartup = reject;
		});
		const polling = this.bot.start({
			allowed_updates: allowedUpdates,
			drop_pending_updates: true,
			onStart: () => {
				startupSettled = true;
				resolveStartup?.();
			},
		});
		this.pollingPromise = polling;
		void polling.catch((error) => {
			if (!startupSettled) {
				rejectStartup?.(error);
				return;
			}
			this.logWarn(error, "Telegram polling failed");
		});
		await startup;
	}

	async stop(): Promise<void> {
		const started = this.startPromise;
		if (!started) return;
		this.startPromise = null;
		await started.catch(() => undefined);
		const polling = this.pollingPromise;
		this.pollingPromise = null;
		if (!polling) return;
		await this.bot.stop();
		await polling.catch(() => undefined);
	}

	async createForumTopic(input: {
		chatId: string;
		name: string;
	}): Promise<{ messageThreadId: number }> {
		const result = await this.bot.api.createForumTopic(input.chatId, input.name);
		return { messageThreadId: result.message_thread_id };
	}

	async editForumTopic(input: {
		chatId: string;
		messageThreadId: number;
		name: string;
	}): Promise<void> {
		await this.bot.api.editForumTopic(input.chatId, input.messageThreadId, { name: input.name });
	}

	async closeForumTopic(input: { chatId: string; messageThreadId: number }): Promise<void> {
		await this.bot.api.closeForumTopic(input.chatId, input.messageThreadId);
	}

	async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSentMessage> {
		const result = await this.bot.api.sendMessage(input.chatId, input.text, {
			...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
			...(input.parseMode ? { parse_mode: input.parseMode } : {}),
			...(input.replyMarkup ? { reply_markup: toTelegramReplyMarkup(input.replyMarkup) } : {}),
		});
		return { messageId: result.message_id };
	}

	async sendPhoto(input: TelegramSendFileInput): Promise<TelegramSentMessage> {
		const result = await this.bot.api.sendPhoto(
			input.chatId,
			new InputFile(input.bytes, input.filename),
			this.fileOptions(input),
		);
		return { messageId: result.message_id };
	}

	async sendDocument(input: TelegramSendFileInput): Promise<TelegramSentMessage> {
		const result = await this.bot.api.sendDocument(
			input.chatId,
			new InputFile(input.bytes, input.filename),
			this.fileOptions(input),
		);
		return { messageId: result.message_id };
	}

	private fileOptions(input: TelegramSendFileInput): Record<string, unknown> {
		return {
			...(input.messageThreadId !== undefined ? { message_thread_id: input.messageThreadId } : {}),
			...(input.caption ? { caption: input.caption } : {}),
			...(input.parseMode ? { parse_mode: input.parseMode } : {}),
		};
	}

	async answerCallbackQuery(input: {
		callbackQueryId: string;
		text?: string;
		showAlert?: boolean;
	}): Promise<void> {
		await this.bot.api.answerCallbackQuery(input.callbackQueryId, {
			...(input.text ? { text: input.text } : {}),
			...(input.showAlert !== undefined ? { show_alert: input.showAlert } : {}),
		});
	}

	private async dispatchText(ctx: GrammyTextContext): Promise<void> {
		const message = ctx.message;
		const update: TelegramTextUpdate = {
			messageId: message.message_id,
			chatId: String(message.chat.id),
			...(message.message_thread_id !== undefined
				? { messageThreadId: message.message_thread_id }
				: {}),
			from: toUserRef(message.from),
			text: message.text,
		};
		await Promise.all([...this.textHandlers].map((handler) => handler(update)));
	}

	private async dispatchForumTopic(
		ctx: GrammyForumTopicContext,
		handlers: ReadonlySet<TelegramForumTopicCreatedHandler>,
	): Promise<void> {
		const message = ctx.message;
		if (message.message_thread_id === undefined) return;
		const update: TelegramForumTopicCreatedUpdate = {
			messageId: message.message_id,
			chatId: String(message.chat.id),
			messageThreadId: message.message_thread_id,
			from: toUserRef(message.from),
		};
		await Promise.all([...handlers].map((handler) => handler(update)));
	}

	private async dispatchCallback(ctx: GrammyCallbackContext): Promise<void> {
		const callback = ctx.callbackQuery;
		if (!callback.message) return;
		const update: TelegramCallbackUpdate = {
			id: callback.id,
			chatId: String(callback.message.chat.id),
			...(callback.message.message_thread_id !== undefined
				? { messageThreadId: callback.message.message_thread_id }
				: {}),
			from: toUserRef(callback.from),
			data: callback.data,
		};
		await Promise.all([...this.callbackHandlers].map((handler) => handler(update)));
	}

	private logWarn(error: unknown, message: string): void {
		this.input.logger?.warn?.(
			{ err: error instanceof Error ? error.message : String(error) },
			message,
		);
	}
}
