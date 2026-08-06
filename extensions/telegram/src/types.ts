export type TelegramParseMode = "HTML";

export interface TelegramInlineKeyboardButton {
	text: string;
	callbackData: string;
}

export interface TelegramReplyMarkupBase {
	inlineKeyboard?: readonly (readonly TelegramInlineKeyboardButton[])[];
	forceReply?: true;
	inputFieldPlaceholder?: string;
	selective?: boolean;
}

export interface TelegramInlineKeyboard extends TelegramReplyMarkupBase {
	inlineKeyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export interface TelegramForceReply extends TelegramReplyMarkupBase {
	forceReply: true;
}

export type TelegramReplyMarkup = TelegramInlineKeyboard | TelegramForceReply;

export interface TelegramUserRef {
	id: number;
	username?: string;
}

export interface TelegramTextUpdate {
	messageId: number;
	chatId: string;
	messageThreadId?: number;
	from: TelegramUserRef | null;
	text: string;
}

export interface TelegramCallbackUpdate {
	id: string;
	chatId: string;
	messageThreadId?: number;
	from: TelegramUserRef | null;
	data: string;
}

export interface TelegramForumTopicCreatedUpdate {
	messageId: number;
	chatId: string;
	messageThreadId: number;
	from: TelegramUserRef | null;
}

export interface TelegramForumTopicClosedUpdate {
	messageId: number;
	chatId: string;
	messageThreadId: number;
	from: TelegramUserRef | null;
}

export type TelegramTextHandler = (update: TelegramTextUpdate) => void | Promise<void>;
export type TelegramCallbackHandler = (update: TelegramCallbackUpdate) => void | Promise<void>;
export type TelegramForumTopicCreatedHandler = (
	update: TelegramForumTopicCreatedUpdate,
) => void | Promise<void>;
export type TelegramForumTopicClosedHandler = (
	update: TelegramForumTopicClosedUpdate,
) => void | Promise<void>;

export interface TelegramSendMessageInput {
	chatId: string;
	messageThreadId?: number;
	text: string;
	parseMode?: TelegramParseMode;
	replyMarkup?: TelegramReplyMarkup;
}

export interface TelegramSendFileInput {
	chatId: string;
	messageThreadId?: number;
	bytes: Uint8Array;
	filename: string;
	caption?: string;
	parseMode?: TelegramParseMode;
}

export interface TelegramSentMessage {
	messageId: number;
}

export interface TelegramClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	createForumTopic(input: { chatId: string; name: string }): Promise<{ messageThreadId: number }>;
	editForumTopic(input: { chatId: string; messageThreadId: number; name: string }): Promise<void>;
	closeForumTopic(input: { chatId: string; messageThreadId: number }): Promise<void>;
	sendMessage(input: TelegramSendMessageInput): Promise<TelegramSentMessage>;
	sendPhoto(input: TelegramSendFileInput): Promise<TelegramSentMessage>;
	sendDocument(input: TelegramSendFileInput): Promise<TelegramSentMessage>;
	answerCallbackQuery(input: {
		callbackQueryId: string;
		text?: string;
		showAlert?: boolean;
	}): Promise<void>;
	onText(handler: TelegramTextHandler): void;
	onCallback(handler: TelegramCallbackHandler): void;
	onForumTopicCreated(handler: TelegramForumTopicCreatedHandler): void;
	onForumTopicClosed(handler: TelegramForumTopicClosedHandler): void;
}

export abstract class BaseTelegramClientEventRegistrar {
	protected textHandlers = new Set<TelegramTextHandler>();
	protected callbackHandlers = new Set<TelegramCallbackHandler>();
	protected forumTopicCreatedHandlers = new Set<TelegramForumTopicCreatedHandler>();
	protected forumTopicClosedHandlers = new Set<TelegramForumTopicClosedHandler>();

	onText(handler: TelegramTextHandler): void {
		this.textHandlers.add(handler);
	}

	onCallback(handler: TelegramCallbackHandler): void {
		this.callbackHandlers.add(handler);
	}

	onForumTopicCreated(handler: TelegramForumTopicCreatedHandler): void {
		this.forumTopicCreatedHandlers.add(handler);
	}

	onForumTopicClosed(handler: TelegramForumTopicClosedHandler): void {
		this.forumTopicClosedHandlers.add(handler);
	}
}

export interface TelegramProcessThread {
	mode: "forum_topic";
	chatId: string;
	messageThreadId: number;
	topicName: string;
}
