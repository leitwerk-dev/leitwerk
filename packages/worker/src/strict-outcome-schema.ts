import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isUnknownRecord } from "@leitwerk-dev/domain";
import type { PiCustomTool, PiSessionDiagnostic } from "@leitwerk-dev/process-sdk";

const activeContracts = new WeakMap<object, ReadonlySet<string>>();

/** @internal */
export function supportsStrictOutcomeSchemas(api: string): boolean {
	return api === "openai-responses" || api === "openai-completions";
}

/** @internal */
export function strictOutcomeToolNames(session: AgentSession): ReadonlySet<string> {
	return activeContracts.get(session) ?? new Set();
}

/** Apply native schemas after Pi serialization, bypassing its object-union converter. @internal */
export function enforceStrictOutcomePayload(
	payload: unknown,
	api: string,
	tools: readonly PiCustomTool[],
): unknown {
	if (!supportsStrictOutcomeSchemas(api)) return payload;
	if (!isUnknownRecord(payload))
		throw new Error("Cannot enforce outcome schemas: provider payload is not an object");
	const strict = new Map(
		tools.filter((tool) => tool.strictSchema).map((tool) => [tool.name, tool]),
	);
	if (!Array.isArray(payload.tools)) return payload;
	return {
		...payload,
		tools: payload.tools.map((raw) => {
			if (!isUnknownRecord(raw) || raw.type !== "function") return raw;
			const declaration = api === "openai-completions" ? raw.function : raw;
			if (!isUnknownRecord(declaration) || typeof declaration.name !== "string") return raw;
			const tool = strict.get(declaration.name);
			if (!tool) return raw;
			const enforced = { ...declaration, strict: true, parameters: tool.parameters };
			return api === "openai-completions" ? { ...raw, function: enforced } : enforced;
		}),
	};
}

/** @internal */
export function installStrictOutcomeSchemas(
	session: AgentSession,
	tools: readonly PiCustomTool[],
	emit: (diagnostic: PiSessionDiagnostic) => void,
): () => void {
	const optedIn = tools.filter((tool) => tool.strictSchema);
	if (!optedIn.length) return () => {};
	const previousNames = activeContracts.get(session);
	activeContracts.set(session, new Set(optedIn.map((tool) => tool.name)));
	const previousPayload = session.agent.onPayload;
	const previousStream = session.agent.streamFunction;
	const reported = new Set<string>();
	session.agent.onPayload = async (payload, model) => {
		const resolved = await previousPayload?.(payload, model);
		return enforceStrictOutcomePayload(
			resolved === undefined ? payload : resolved,
			model.api,
			optedIn,
		);
	};
	session.agent.streamFunction = (model, context, options) => {
		if (!supportsStrictOutcomeSchemas(model.api) && !reported.has(model.api)) {
			reported.add(model.api);
			emit({
				level: "warn",
				code: "strict_outcome_schema_unsupported",
				timestamp: new Date().toISOString(),
				message: `Provider API '${model.api}' does not support outcome schema enforcement; server validation remains active.`,
				details: { api: model.api, tools: optedIn.map((tool) => tool.name) },
			});
		}
		return previousStream.call(session.agent, model, context, options);
	};
	return () => {
		session.agent.onPayload = previousPayload;
		session.agent.streamFunction = previousStream;
		if (previousNames) activeContracts.set(session, previousNames);
		else activeContracts.delete(session);
	};
}
