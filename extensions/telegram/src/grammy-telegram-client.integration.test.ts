import { describe, expect, it } from "vitest";
import { GrammyTelegramClient } from "./grammy-telegram-client.js";

class FakeGrammyBot {
	readonly apiCalls: Array<{ method: string; args: unknown[] }> = [];
	readonly handlers = new Map<string, (ctx: unknown) => void | Promise<void>>();
	startOptions: Record<string, unknown> | null = null;
	stopped = false;
	getUpdatesError: Error | null = null;

	api = {
		getUpdates: async (...args: [Record<string, unknown>]) => {
			this.apiCalls.push({ method: "getUpdates", args });
			if (this.getUpdatesError) throw this.getUpdatesError;
			return [];
		},
		createForumTopic: async (...args: [string, string]) => {
			this.apiCalls.push({ method: "createForumTopic", args });
			return { message_thread_id: 42 };
		},
		editForumTopic: async (...args: [string, number, { name: string }]) => {
			this.apiCalls.push({ method: "editForumTopic", args });
			return true;
		},
		closeForumTopic: async (...args: [string, number]) => {
			this.apiCalls.push({ method: "closeForumTopic", args });
			return true;
		},
		sendMessage: async (...args: [string, string, Record<string, unknown>?]) => {
			this.apiCalls.push({ method: "sendMessage", args });
			return { message_id: 7 };
		},
		sendPhoto: async (...args: [string, unknown, Record<string, unknown>?]) => {
			this.apiCalls.push({ method: "sendPhoto", args });
			return { message_id: 8 };
		},
		sendDocument: async (...args: [string, unknown, Record<string, unknown>?]) => {
			this.apiCalls.push({ method: "sendDocument", args });
			return { message_id: 9 };
		},
		answerCallbackQuery: async (...args: [string, Record<string, unknown>?]) => {
			this.apiCalls.push({ method: "answerCallbackQuery", args });
			return true;
		},
	};

	on(
		filter:
			| "message:text"
			| "message:forum_topic_created"
			| "message:forum_topic_closed"
			| "callback_query:data",
		handler: (ctx: never) => void | Promise<void>,
	) {
		this.handlers.set(filter, handler as (ctx: unknown) => void | Promise<void>);
	}

	async start(options?: Record<string, unknown>): Promise<void> {
		this.startOptions = options ?? null;
		const onStart = options?.onStart;
		if (typeof onStart === "function") onStart();
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}
}

describe("GrammyTelegramClient", () => {
	it("starts grammy polling with pending-update drop enabled", async () => {
		const bot = new FakeGrammyBot();
		const client = new GrammyTelegramClient({ botToken: "token", botFactory: () => bot });

		await client.start();
		await client.stop();

		expect(bot.startOptions).toMatchObject({
			allowed_updates: ["message", "callback_query"],
			drop_pending_updates: true,
		});
		expect(bot.apiCalls[0]).toMatchObject({
			method: "getUpdates",
			args: [expect.objectContaining({ timeout: 0, limit: 1, offset: -1 })],
		});
		expect(bot.stopped).toBe(true);
	});

	it.each([401, 409])("rejects Telegram %s during the exclusive startup poll", async (status) => {
		const bot = new FakeGrammyBot();
		bot.getUpdatesError = new Error(`${status} Telegram startup rejected`);
		const client = new GrammyTelegramClient({ botToken: "token", botFactory: () => bot });

		await expect(client.start()).rejects.toThrow(String(status));
		expect(bot.startOptions).toBeNull();
	});

	it("can restart after the previous poller stops", async () => {
		const bot = new FakeGrammyBot();
		const client = new GrammyTelegramClient({ botToken: "token", botFactory: () => bot });

		await client.start();
		await client.stop();
		await client.start();
		await client.stop();

		expect(bot.apiCalls.filter((call) => call.method === "getUpdates")).toHaveLength(2);
	});

	it("maps Telegram client calls to grammy API calls", async () => {
		const bot = new FakeGrammyBot();
		const client = new GrammyTelegramClient({ botToken: "token", botFactory: () => bot });

		await expect(client.createForumTopic({ chatId: "-100", name: "topic" })).resolves.toEqual({
			messageThreadId: 42,
		});
		await client.editForumTopic({ chatId: "-100", messageThreadId: 42, name: "renamed" });
		await client.closeForumTopic({ chatId: "-100", messageThreadId: 42 });
		await expect(
			client.sendMessage({
				chatId: "-100",
				messageThreadId: 42,
				text: "hello",
				parseMode: "HTML",
				replyMarkup: {
					inlineKeyboard: [[{ text: "Run", callbackData: "action:run" }]],
				},
			}),
		).resolves.toEqual({ messageId: 7 });
		await expect(
			client.sendPhoto({
				chatId: "-100",
				messageThreadId: 42,
				bytes: new Uint8Array([1, 2, 3]),
				filename: "evidence.png",
				caption: "Evidence",
			}),
		).resolves.toEqual({ messageId: 8 });
		await expect(
			client.sendDocument({
				chatId: "-100",
				messageThreadId: 42,
				bytes: new Uint8Array([1, 2, 3]),
				filename: "evidence.png",
			}),
		).resolves.toEqual({ messageId: 9 });
		await client.answerCallbackQuery({ callbackQueryId: "cb", text: "done", showAlert: true });

		expect(bot.apiCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ method: "createForumTopic" }),
				expect.objectContaining({ method: "editForumTopic" }),
				expect.objectContaining({ method: "closeForumTopic" }),
				expect.objectContaining({ method: "sendMessage" }),
				expect.objectContaining({ method: "sendPhoto" }),
				expect.objectContaining({ method: "sendDocument" }),
				expect.objectContaining({ method: "answerCallbackQuery" }),
			]),
		);
		expect(bot.apiCalls.find((call) => call.method === "sendMessage")?.args[2]).toMatchObject({
			message_thread_id: 42,
			parse_mode: "HTML",
			reply_markup: { inline_keyboard: [[{ text: "Run", callback_data: "action:run" }]] },
		});
		expect(bot.apiCalls.find((call) => call.method === "sendPhoto")?.args[2]).toMatchObject({
			message_thread_id: 42,
			caption: "Evidence",
		});
	});

	it("normalizes grammy text and callback updates", async () => {
		const bot = new FakeGrammyBot();
		const client = new GrammyTelegramClient({ botToken: "token", botFactory: () => bot });
		const updates: unknown[] = [];
		client.onText((update) => updates.push(update));
		client.onCallback((update) => updates.push(update));

		await bot.handlers.get("message:text")?.({
			message: {
				message_id: 1,
				message_thread_id: 42,
				chat: { id: -100 },
				from: { id: 123, username: "operator" },
				text: "hello",
			},
		});
		await bot.handlers.get("callback_query:data")?.({
			callbackQuery: {
				id: "cb",
				from: { id: 123 },
				data: "retry",
				message: { message_thread_id: 42, chat: { id: -100 } },
			},
		});

		expect(updates).toEqual([
			expect.objectContaining({ chatId: "-100", messageThreadId: 42, text: "hello" }),
			expect.objectContaining({ id: "cb", chatId: "-100", messageThreadId: 42, data: "retry" }),
		]);
	});

	it("normalizes forum topic closed updates", async () => {
		const bot = new FakeGrammyBot();
		const client = new GrammyTelegramClient({ botToken: "token", botFactory: () => bot });
		const updates: unknown[] = [];
		client.onForumTopicClosed((update) => updates.push(update));

		await bot.handlers.get("message:forum_topic_closed")?.({
			message: {
				message_id: 9,
				message_thread_id: 42,
				chat: { id: -100 },
				from: { id: 123, username: "operator" },
				forum_topic_closed: {},
			},
		});

		expect(updates).toEqual([
			expect.objectContaining({
				messageId: 9,
				chatId: "-100",
				messageThreadId: 42,
				from: { id: 123, username: "operator" },
			}),
		]);
	});
});
