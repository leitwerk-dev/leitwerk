/** @internal */
export type TelegramParseMode = "HTML";

/** @internal */
export interface TelegramInlineKeyboardButton {
	/** @internal */
	text: string;
	/** @internal */
	callbackData: string;
}

/** @internal */
export interface TelegramReplyMarkupBase {
	/** @internal */
	inlineKeyboard?: readonly (readonly TelegramInlineKeyboardButton[])[];
	/** @internal */
	forceReply?: true;
	/** @internal */
	inputFieldPlaceholder?: string;
	/** @internal */
	selective?: boolean;
}

/** @internal */
export interface TelegramInlineKeyboard extends TelegramReplyMarkupBase {
	/** @internal */
	inlineKeyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

/** @internal */
export interface TelegramForceReply extends TelegramReplyMarkupBase {
	/** @internal */
	forceReply: true;
}

/** @internal */
export type TelegramReplyMarkup = TelegramInlineKeyboard | TelegramForceReply;

/** @internal */
export interface TelegramUserRef {
	/** @internal */
	id: number;
	/** @internal */
	username?: string;
}

/** @internal */
export interface TelegramTextUpdate {
	/** @internal */
	messageId: number;
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId?: number;
	/** @internal */
	from: TelegramUserRef | null;
	/** @internal */
	text: string;
}

/** @internal */
export interface TelegramCallbackUpdate {
	/** @internal */
	id: string;
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId?: number;
	/** @internal */
	from: TelegramUserRef | null;
	/** @internal */
	data: string;
}

/** @internal */
interface TelegramForumTopicUpdate {
	/** @internal */
	messageId: number;
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId: number;
	/** @internal */
	from: TelegramUserRef | null;
}

/** @internal */
export interface TelegramForumTopicCreatedUpdate extends TelegramForumTopicUpdate {}

/** @internal */
export interface TelegramForumTopicClosedUpdate extends TelegramForumTopicUpdate {}

/** @internal */
export type TelegramTextHandler = (update: TelegramTextUpdate) => void | Promise<void>;
/** @internal */
export type TelegramCallbackHandler = (update: TelegramCallbackUpdate) => void | Promise<void>;
/** @internal */
export type TelegramForumTopicCreatedHandler = (
	update: TelegramForumTopicCreatedUpdate,
) => void | Promise<void>;
/** @internal */
export type TelegramForumTopicClosedHandler = (
	update: TelegramForumTopicClosedUpdate,
) => void | Promise<void>;

/** @internal */
export interface TelegramSendMessageInput {
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId?: number;
	/** @internal */
	text: string;
	/** @internal */
	parseMode?: TelegramParseMode;
	/** @internal */
	replyMarkup?: TelegramReplyMarkup;
}

/** @internal */
export interface TelegramSendFileInput {
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId?: number;
	/** @internal */
	bytes: Uint8Array;
	/** @internal */
	filename: string;
	/** @internal */
	caption?: string;
	/** @internal */
	parseMode?: TelegramParseMode;
}

/** @internal */
export interface TelegramSentMessage {
	/** @internal */
	messageId: number;
}

/** @internal */
export interface TelegramClient {
	/** @internal */
	start(): Promise<void>;
	/** @internal */
	stop(): Promise<void>;
	/** @internal */
	createForumTopic(input: {
		/** @internal */
		chatId: string;
		/** @internal */
		name: string;
	}): Promise<{
		/** @internal */
		messageThreadId: number;
	}>;
	/** @internal */
	editForumTopic(input: {
		/** @internal */
		chatId: string;
		/** @internal */
		messageThreadId: number;
		/** @internal */
		name: string;
	}): Promise<void>;
	/** @internal */
	closeForumTopic(input: {
		/** @internal */
		chatId: string;
		/** @internal */
		messageThreadId: number;
	}): Promise<void>;
	/** @internal */
	sendMessage(input: TelegramSendMessageInput): Promise<TelegramSentMessage>;
	/** @internal */
	sendPhoto(input: TelegramSendFileInput): Promise<TelegramSentMessage>;
	/** @internal */
	sendDocument(input: TelegramSendFileInput): Promise<TelegramSentMessage>;
	/** @internal */
	answerCallbackQuery(input: {
		/** @internal */
		callbackQueryId: string;
		/** @internal */
		text?: string;
		/** @internal */
		showAlert?: boolean;
	}): Promise<void>;
	/** @internal */
	onText(handler: TelegramTextHandler): void;
	/** @internal */
	onCallback(handler: TelegramCallbackHandler): void;
	/** @internal */
	onForumTopicCreated(handler: TelegramForumTopicCreatedHandler): void;
	/** @internal */
	onForumTopicClosed(handler: TelegramForumTopicClosedHandler): void;
}

/** @internal */
export abstract class BaseTelegramClientEventRegistrar {
	/** @internal */
	protected textHandlers = new Set<TelegramTextHandler>();
	/** @internal */
	protected callbackHandlers = new Set<TelegramCallbackHandler>();
	/** @internal */
	protected forumTopicCreatedHandlers = new Set<TelegramForumTopicCreatedHandler>();
	/** @internal */
	protected forumTopicClosedHandlers = new Set<TelegramForumTopicClosedHandler>();

	/** @internal */
	onText(handler: TelegramTextHandler): void {
		this.textHandlers.add(handler);
	}

	/** @internal */
	onCallback(handler: TelegramCallbackHandler): void {
		this.callbackHandlers.add(handler);
	}

	/** @internal */
	onForumTopicCreated(handler: TelegramForumTopicCreatedHandler): void {
		this.forumTopicCreatedHandlers.add(handler);
	}

	/** @internal */
	onForumTopicClosed(handler: TelegramForumTopicClosedHandler): void {
		this.forumTopicClosedHandlers.add(handler);
	}
}

/** @internal */
export interface TelegramProcessThread {
	/** @internal */
	mode: "forum_topic";
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId: number;
	/** @internal */
	topicName: string;
}
