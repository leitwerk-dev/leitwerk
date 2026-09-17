import {
	type Api,
	completeSimple,
	getModel,
	type Model,
	type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import { isUnknownRecord as isRecord } from "@leitwerk-dev/domain";
import { definePiServerAdapter, type PiServerAdapter } from "@leitwerk-dev/process-sdk";

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function resolveThinkingLevel(value: string): ThinkingLevel | undefined {
	return THINKING_LEVELS.has(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
}

function requireApiKey(secrets: Readonly<Record<string, string>>): string {
	const value = secrets.apiKey ?? secrets.api_key;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error("Built-in Pi provider credentials are unavailable");
	}
	return value;
}

function configuredBaseUrl(config: unknown): string | undefined {
	const value = isRecord(config) ? config.baseUrl : undefined;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function configuredModel(
	config: unknown,
	providerId: string,
	modelId: string,
): Model<Api> | undefined {
	if (!isRecord(config) || !Array.isArray(config.models)) return undefined;
	// The owning provider parses and normalizes these credential-blind definitions.
	return config.models.find(
		(model): model is Model<Api> =>
			isRecord(model) && model.provider === providerId && model.id === modelId,
	);
}

/**
 * Direct, server-only Pi AI adapter. It never reads PI_CODING_AGENT_DIR or an
 * ambient auth file; the current credential revision is supplied per call.
 */
export function createBuiltinPiServerAdapter(builtinProviderId: string): PiServerAdapter {
	return definePiServerAdapter({
		async generateText(input) {
			if (input.providerId !== builtinProviderId) {
				throw new Error(
					`Built-in adapter '${builtinProviderId}' cannot serve provider '${input.providerId}'`,
				);
			}
			const canonicalModel =
				configuredModel(input.config, builtinProviderId, input.modelId) ??
				getModel(builtinProviderId as never, input.modelId as never);
			if (!canonicalModel) {
				throw new Error(`Built-in Pi model '${builtinProviderId}/${input.modelId}' is unavailable`);
			}
			const baseUrl = configuredBaseUrl(input.config);
			const model = baseUrl ? { ...canonicalModel, baseUrl } : canonicalModel;
			const reasoning = resolveThinkingLevel(input.thinkingLevel);
			const message = await completeSimple(
				model,
				{
					systemPrompt: input.systemPrompt,
					messages: [
						{
							role: "user",
							content: input.prompt,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: requireApiKey(input.secrets),
					maxTokens: input.maxTokens,
					...(reasoning ? { reasoning } : {}),
					...input.request,
				},
			);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? "Built-in Pi model request failed");
			}
			const text = message.content
				.filter(
					(part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("")
				.trim();
			if (!text) throw new Error("Built-in Pi model returned no text");
			return text;
		},
	});
}
