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

/** @internal */
export interface FakeTelegramTopic {
	/** @internal */
	chatId: string;
	/** @internal */
	name: string;
	/** @internal */
	messageThreadId: number;
}

/** @internal */
export interface FakeTelegramTopicEdit {
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId: number;
	/** @internal */
	name: string;
}

/** @internal */
export interface FakeTelegramTopicClose {
	/** @internal */
	chatId: string;
	/** @internal */
	messageThreadId: number;
}

/** @internal */
export interface FakeTelegramAnswerCallback {
	/** @internal */
	callbackQueryId: string;
	/** @internal */
	text?: string;
	/** @internal */
	showAlert?: boolean;
}

/** @internal */
export type FakeTelegramOperation =
	| {
			/** @internal */
			kind: "createForumTopic";
			/** @internal */
			input: FakeTelegramTopic;
	  }
	| {
			/** @internal */
			kind: "editForumTopic";
			/** @internal */
			input: FakeTelegramTopicEdit;
	  }
	| {
			/** @internal */
			kind: "closeForumTopic";
			/** @internal */
			input: FakeTelegramTopicClose;
	  }
	| {
			/** @internal */
			kind: "sendMessage";
			/** @internal */
			input: TelegramSendMessageInput;
	  }
	| {
			/** @internal */
			kind: "sendPhoto";
			/** @internal */
			input: TelegramSendFileInput;
	  }
	| {
			/** @internal */
			kind: "sendDocument";
			/** @internal */
			input: TelegramSendFileInput;
	  }
	| {
			/** @internal */
			kind: "answerCallbackQuery";
			/** @internal */
			input: FakeTelegramAnswerCallback;
	  };

/** @internal */
export class FakeTelegramClient extends BaseTelegramClientEventRegistrar implements TelegramClient {
	/** @internal */
	readonly operations: FakeTelegramOperation[] = [];
	/** @internal */
	readonly createdTopics: FakeTelegramTopic[] = [];
	/** @internal */
	readonly editedTopics: FakeTelegramTopicEdit[] = [];
	/** @internal */
	readonly closedTopics: FakeTelegramTopicClose[] = [];
	/** @internal */
	readonly sentMessages: TelegramSendMessageInput[] = [];
	/** @internal */
	readonly sentPhotos: TelegramSendFileInput[] = [];
	/** @internal */
	readonly sentDocuments: TelegramSendFileInput[] = [];
	/** @internal */
	readonly answeredCallbacks: FakeTelegramAnswerCallback[] = [];
	private nextThreadId = 100;
	private nextMessageId = 1;
	private createForumTopicFailures: Error[] = [];
	private sendPhotoFailures: Error[] = [];
	private sendDocumentFailures: Error[] = [];
	private sendMessageFailure: { remainingSuccessfulSends: number; error: Error } | null = null;
	/** @internal */
	started = false;

	/** @internal */
	async start(): Promise<void> {
		this.started = true;
	}

	/** @internal */
	async stop(): Promise<void> {
		this.started = false;
	}

	/** @internal */
	failNextCreateForumTopic(error = new Error("createForumTopic failed")): void {
		this.createForumTopicFailures.push(error);
	}

	/** @internal */
	failSendMessageAfter(successfulSends: number, error = new Error("sendMessage failed")): void {
		this.sendMessageFailure = {
			remainingSuccessfulSends: Math.max(0, successfulSends),
			error,
		};
	}

	/** @internal */
	failNextSendPhoto(error = new Error("sendPhoto failed")): void {
		this.sendPhotoFailures.push(error);
	}

	/** @internal */
	failNextSendDocument(error = new Error("sendDocument failed")): void {
		this.sendDocumentFailures.push(error);
	}

	/** @internal */
	async createForumTopic(input: {
		/** @internal */
		chatId: string;
		/** @internal */
		name: string;
	}): Promise<{
		/** @internal */
		messageThreadId: number;
	}> {
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

	/** @internal */
	async editForumTopic(input: FakeTelegramTopicEdit): Promise<void> {
		this.operations.push({ kind: "editForumTopic", input });
		this.editedTopics.push(input);
	}

	/** @internal */
	async closeForumTopic(input: FakeTelegramTopicClose): Promise<void> {
		this.operations.push({ kind: "closeForumTopic", input });
		this.closedTopics.push(input);
	}

	/** @internal */
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

	/** @internal */
	async sendPhoto(input: TelegramSendFileInput): Promise<TelegramSentMessage> {
		const failure = this.sendPhotoFailures.shift();
		if (failure) throw failure;
		this.operations.push({ kind: "sendPhoto", input });
		this.sentPhotos.push(input);
		return { messageId: this.nextMessageId++ };
	}

	/** @internal */
	async sendDocument(input: TelegramSendFileInput): Promise<TelegramSentMessage> {
		const failure = this.sendDocumentFailures.shift();
		if (failure) throw failure;
		this.operations.push({ kind: "sendDocument", input });
		this.sentDocuments.push(input);
		return { messageId: this.nextMessageId++ };
	}

	/** @internal */
	async answerCallbackQuery(input: FakeTelegramAnswerCallback): Promise<void> {
		this.operations.push({ kind: "answerCallbackQuery", input });
		this.answeredCallbacks.push(input);
	}

	/** @internal */
	async simulateText(update: TelegramTextUpdate): Promise<void> {
		await Promise.all([...this.textHandlers].map((handler) => handler(update)));
	}

	/** @internal */
	async simulateCallback(update: TelegramCallbackUpdate): Promise<void> {
		await Promise.all([...this.callbackHandlers].map((handler) => handler(update)));
	}

	/** @internal */
	async simulateForumTopicCreated(update: TelegramForumTopicCreatedUpdate): Promise<void> {
		await Promise.all([...this.forumTopicCreatedHandlers].map((handler) => handler(update)));
	}

	/** @internal */
	async simulateForumTopicClosed(update: TelegramForumTopicClosedUpdate): Promise<void> {
		await Promise.all([...this.forumTopicClosedHandlers].map((handler) => handler(update)));
	}
}
