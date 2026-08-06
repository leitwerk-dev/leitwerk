import {
	BaseTelegramClientEventRegistrar,
	type TelegramCallbackUpdate,
	type TelegramClient,
	type TelegramForumTopicClosedUpdate,
	type TelegramForumTopicCreatedUpdate,
	type TelegramSendFileInput,
	type TelegramSendMessageInput,
	type TelegramSentMessage,
	type TelegramTextUpdate,
} from "./types.js";

export interface FakeTelegramTopic {
	chatId: string;
	name: string;
	messageThreadId: number;
}

export interface FakeTelegramTopicEdit {
	chatId: string;
	messageThreadId: number;
	name: string;
}

export interface FakeTelegramTopicClose {
	chatId: string;
	messageThreadId: number;
}

export interface FakeTelegramAnswerCallback {
	callbackQueryId: string;
	text?: string;
	showAlert?: boolean;
}

export type FakeTelegramOperation =
	| { kind: "createForumTopic"; input: FakeTelegramTopic }
	| { kind: "editForumTopic"; input: FakeTelegramTopicEdit }
	| { kind: "closeForumTopic"; input: FakeTelegramTopicClose }
	| { kind: "sendMessage"; input: TelegramSendMessageInput }
	| { kind: "sendPhoto"; input: TelegramSendFileInput }
	| { kind: "sendDocument"; input: TelegramSendFileInput }
	| { kind: "answerCallbackQuery"; input: FakeTelegramAnswerCallback };

export class FakeTelegramClient extends BaseTelegramClientEventRegistrar implements TelegramClient {
	readonly operations: FakeTelegramOperation[] = [];
	readonly createdTopics: FakeTelegramTopic[] = [];
	readonly editedTopics: FakeTelegramTopicEdit[] = [];
	readonly closedTopics: FakeTelegramTopicClose[] = [];
	readonly sentMessages: TelegramSendMessageInput[] = [];
	readonly sentPhotos: TelegramSendFileInput[] = [];
	readonly sentDocuments: TelegramSendFileInput[] = [];
	readonly answeredCallbacks: FakeTelegramAnswerCallback[] = [];
	private nextThreadId = 100;
	private nextMessageId = 1;
	private createForumTopicFailures: Error[] = [];
	private sendPhotoFailures: Error[] = [];
	private sendDocumentFailures: Error[] = [];
	private sendMessageFailure: { remainingSuccessfulSends: number; error: Error } | null = null;
	started = false;

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	failNextCreateForumTopic(error = new Error("createForumTopic failed")): void {
		this.createForumTopicFailures.push(error);
	}

	failSendMessageAfter(successfulSends: number, error = new Error("sendMessage failed")): void {
		this.sendMessageFailure = {
			remainingSuccessfulSends: Math.max(0, successfulSends),
			error,
		};
	}

	failNextSendPhoto(error = new Error("sendPhoto failed")): void {
		this.sendPhotoFailures.push(error);
	}

	failNextSendDocument(error = new Error("sendDocument failed")): void {
		this.sendDocumentFailures.push(error);
	}

	async createForumTopic(input: {
		chatId: string;
		name: string;
	}): Promise<{ messageThreadId: number }> {
		const failure = this.createForumTopicFailures.shift();
		if (failure) {
			throw failure;
		}
		const topic = {
			chatId: input.chatId,
			name: input.name,
			messageThreadId: this.nextThreadId++,
		};
		this.operations.push({ kind: "createForumTopic", input: topic });
		this.createdTopics.push(topic);
		return { messageThreadId: topic.messageThreadId };
	}

	async editForumTopic(input: FakeTelegramTopicEdit): Promise<void> {
		this.operations.push({ kind: "editForumTopic", input });
		this.editedTopics.push(input);
	}

	async closeForumTopic(input: FakeTelegramTopicClose): Promise<void> {
		this.operations.push({ kind: "closeForumTopic", input });
		this.closedTopics.push(input);
	}

	async sendMessage(input: TelegramSendMessageInput): Promise<TelegramSentMessage> {
		const failure = this.sendMessageFailure;
		if (failure) {
			if (failure.remainingSuccessfulSends <= 0) {
				this.sendMessageFailure = null;
				throw failure.error;
			}
			failure.remainingSuccessfulSends -= 1;
		}
		this.operations.push({ kind: "sendMessage", input });
		this.sentMessages.push(input);
		return { messageId: this.nextMessageId++ };
	}

	async sendPhoto(input: TelegramSendFileInput): Promise<TelegramSentMessage> {
		const failure = this.sendPhotoFailures.shift();
		if (failure) throw failure;
		this.operations.push({ kind: "sendPhoto", input });
		this.sentPhotos.push(input);
		return { messageId: this.nextMessageId++ };
	}

	async sendDocument(input: TelegramSendFileInput): Promise<TelegramSentMessage> {
		const failure = this.sendDocumentFailures.shift();
		if (failure) throw failure;
		this.operations.push({ kind: "sendDocument", input });
		this.sentDocuments.push(input);
		return { messageId: this.nextMessageId++ };
	}

	async answerCallbackQuery(input: FakeTelegramAnswerCallback): Promise<void> {
		this.operations.push({ kind: "answerCallbackQuery", input });
		this.answeredCallbacks.push(input);
	}

	async simulateText(update: TelegramTextUpdate): Promise<void> {
		await Promise.all([...this.textHandlers].map((handler) => handler(update)));
	}

	async simulateCallback(update: TelegramCallbackUpdate): Promise<void> {
		await Promise.all([...this.callbackHandlers].map((handler) => handler(update)));
	}

	async simulateForumTopicCreated(update: TelegramForumTopicCreatedUpdate): Promise<void> {
		await Promise.all([...this.forumTopicCreatedHandlers].map((handler) => handler(update)));
	}

	async simulateForumTopicClosed(update: TelegramForumTopicClosedUpdate): Promise<void> {
		await Promise.all([...this.forumTopicClosedHandlers].map((handler) => handler(update)));
	}
}
