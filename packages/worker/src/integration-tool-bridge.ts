import type { PiCustomTool } from "@leitwerk-dev/process-sdk";
import type {
	IntegrationToolDeclaration,
	ServerToWorkerMessage,
	WorkerIntegrationToolRequestPayload,
	WorkerIntegrationToolResultPayload,
} from "@leitwerk-dev/worker-protocol";
import { ReplayingRequestBridge } from "./replaying-request-bridge.js";
import type { WorkerIpcReporter } from "./worker-ipc-reporter.js";

export class WorkerIntegrationToolBridge {
	private readonly bridge: ReplayingRequestBridge<
		WorkerIntegrationToolRequestPayload,
		WorkerIntegrationToolResultPayload,
		unknown
	>;

	constructor(reporter: WorkerIpcReporter) {
		this.bridge = new ReplayingRequestBridge(
			(payload) =>
				reporter.project({ kind: "protocol", type: "worker.integration_tool_request", payload }),
			(payload) => {
				if (!payload.ok) {
					throw new Error(payload.error ?? "Integration tool execution failed");
				}
				return payload.result;
			},
			(payload) =>
				reporter.project({
					kind: "protocol",
					type: "worker.integration_tool_cancel",
					payload: {
						turnRecordId: payload.turnRecordId,
						toolCallId: payload.toolCallId,
						toolName: payload.toolName,
					},
				}),
		);
	}

	createTools(
		declarations: readonly IntegrationToolDeclaration[],
		turnRecordId: string,
	): PiCustomTool[] {
		return declarations.map((declaration) => ({
			...declaration,
			executionMode: "sequential" as const,
			execute: async (args, context) => {
				if (!context?.toolCallId) {
					throw new Error("Integration tool call is missing its Pi identity");
				}
				const resumeGuards = context.suspendPromptGuards?.();
				try {
					return await this.bridge.request(
						{
							turnRecordId,
							toolCallId: context.toolCallId,
							toolName: declaration.name,
							args,
						},
						context.signal,
						"Integration tool call cancelled because the turn stopped",
					);
				} finally {
					resumeGuards?.();
				}
			},
		}));
	}

	handle(
		message: Extract<ServerToWorkerMessage, { type: "worker.integration_tool_result" }>,
	): boolean {
		return this.bridge.handle(message.payload);
	}

	replay(): void {
		this.bridge.replay();
	}

	cancelAll(reason: string): void {
		this.bridge.cancelAll(reason);
	}
}
