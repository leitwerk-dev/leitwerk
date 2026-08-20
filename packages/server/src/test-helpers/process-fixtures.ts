import type { TurnId } from "@leitwerk-dev/domain";
import {
	type AutomaticTurnDefinition,
	automaticTurn,
	defineProcess,
	type ExtensionProcessDefinition,
	type HumanTurnDefinition,
	humanTurn,
	type LlmTurnDefinition,
	llmTurn,
	type ServerAutomaticTurnDefinition,
	serverAutomaticTurn,
	type TurnDefinition,
} from "@leitwerk-dev/process-sdk";

const emptyCodec = {
	parse: () => ({}),
	serialize: (value: Record<string, never>) => value,
};

export function createFixtureLlmTurn(
	description: string,
	overrides: Partial<LlmTurnDefinition<string, Record<string, never>, Record<string, never>>> = {},
): LlmTurnDefinition<string, Record<string, never>, Record<string, never>> {
	return llmTurn({
		availableTools: [],
		description,
		branchType: "primary",
		context: "fresh",
		prompt: async () => description,
		turnEnd: { outcome: "done", params: {}, complete: true },
		...overrides,
	});
}

export function createFixtureHumanTurn(
	overrides: Partial<HumanTurnDefinition<Record<string, never>, Record<string, never>>> = {},
): HumanTurnDefinition<Record<string, never>, Record<string, never>> {
	return humanTurn({
		description: "Review",
		reviewSemanticRef: "plan",
		actions: {
			mark_done: {
				label: "Mark done",
				acceptanceState: "accepted",
				complete: true,
			},
		},
		...overrides,
	});
}

export function createFixtureAutomaticTurn(
	description = "Automatic turn",
): AutomaticTurnDefinition<"done", Record<string, never>, Record<string, never>> {
	return automaticTurn<Record<string, never>, Record<string, never>, "done">({
		description,
		run: async () => ({ outcome: "done", params: {} }),
		turnEnd: { outcome: "done", params: {}, complete: true },
	});
}

export function createFixtureServerAutomaticTurn(
	description = "Server automatic turn",
): ServerAutomaticTurnDefinition<"done", Record<string, never>, Record<string, never>> {
	return serverAutomaticTurn<Record<string, never>, Record<string, never>, "done">({
		description,
		run: async () => ({ outcome: "done", params: {} }),
		turnEnd: { outcome: "done", params: {}, complete: true },
	});
}

function ensureFixtureTurnIsValid(
	definition: TurnDefinition<Record<string, never>, Record<string, never>>,
): TurnDefinition<Record<string, never>, Record<string, never>> {
	if (definition.kind === "human" && Object.keys(definition.actions).length === 0) {
		return {
			...definition,
			actions: {
				__fixture_noop: { label: "No-op", acceptanceState: "neutral", complete: true },
			},
		};
	}
	if (
		(definition.kind === "llm" ||
			definition.kind === "automatic" ||
			definition.kind === "server_automatic") &&
		Object.keys(definition.outcomes ?? {}).length === 0 &&
		!definition.turnEnd
	) {
		return {
			...definition,
			turnEnd: { outcome: "done", params: {}, complete: true },
		} as TurnDefinition<Record<string, never>, Record<string, never>>;
	}
	return definition;
}

export function createFixtureProcess(input: {
	id: string;
	entry: TurnId;
	alternateEntries?: readonly TurnId[];
	turns?: Record<string, TurnDefinition<Record<string, never>, Record<string, never>>>;
}): ExtensionProcessDefinition<Record<string, never>, Record<string, never>> {
	const turns = input.turns ?? {};
	const entries = [input.entry, ...(input.alternateEntries ?? [])];
	return defineProcess<Record<string, never>, Record<string, never>>({
		id: input.id,
		displayName: input.id,
		entry: input.entry,
		...(input.alternateEntries ? { alternateEntries: input.alternateEntries } : {}),
		paramsCodec: emptyCodec,
		stateCodec: emptyCodec,
		initialState: () => ({}),
		turns:
			Object.keys(turns).length > 0
				? Object.fromEntries(
						Object.entries(turns).map(([turnId, definition]) => [
							turnId,
							ensureFixtureTurnIsValid(definition),
						]),
					)
				: Object.fromEntries(entries.map((turnId) => [turnId, createFixtureLlmTurn(turnId)])),
	});
}

export function createProcessGraphRegistry(
	processes: readonly ExtensionProcessDefinition<unknown, unknown>[],
): ReadonlyMap<string, ExtensionProcessDefinition<unknown, unknown>> {
	return new Map(
		processes.map(
			(process) => [process.id, process as ExtensionProcessDefinition<unknown, unknown>] as const,
		),
	);
}

export function createFixtureServerAutomaticProcess(input: {
	id: string;
	turnId?: TurnId;
}): ExtensionProcessDefinition<Record<string, never>, Record<string, never>> {
	const turnId = input.turnId ?? "server_auto";
	return createFixtureProcess({
		id: input.id,
		entry: turnId,
		turns: { [turnId]: createFixtureServerAutomaticTurn() },
	});
}

export function createTurnOwnershipFixtureProcess(
	id = "turn_ownership_process",
): ExtensionProcessDefinition<Record<string, never>, Record<string, never>> {
	return createFixtureProcess({
		id,
		entry: "llm_turn",
		turns: {
			llm_turn: createFixtureLlmTurn("LLM turn"),
			automatic_turn: createFixtureAutomaticTurn(),
			human_turn: createFixtureHumanTurn(),
			server_automatic_turn: createFixtureServerAutomaticTurn(),
		},
	});
}

export function createDefaultTestProcessGraphRegistry(): ReadonlyMap<
	string,
	ExtensionProcessDefinition<unknown, unknown>
> {
	const ticket = createFixtureProcess({
		id: "ticket_issue_process",
		entry: "generate_plan",
		turns: {
			generate_plan: createFixtureLlmTurn("generate_plan", {
				resultSemanticRef: "plan",
				turnEnd: undefined,
				outcomes: { plan_saved: { description: "plan_saved", parameters: {}, to: "plan_review" } },
			}),
			plan_review: createFixtureHumanTurn({
				reviewSemanticRef: "plan",
				actions: {
					revision_requested: {
						label: "Request revision",
						acceptanceState: "requires_changes",
						to: "generate_plan",
					},
					plan_approved: {
						label: "Approve plan",
						acceptanceState: "accepted",
						to: "implement",
					},
				},
			}),
			implement: createFixtureLlmTurn("implement", {
				turnEnd: { outcome: "done", params: {}, to: "handoff_review" },
			}),
			handoff_review: createFixtureLlmTurn("handoff_review", {
				turnEnd: { outcome: "created", params: {}, to: "run_llm_review" },
			}),
			run_llm_review: createFixtureLlmTurn("run_llm_review", {
				resultSemanticRef: "review",
				turnEnd: undefined,
				outcomes: {
					issues_found: { description: "issues_found", parameters: {}, to: "address_review" },
					no_issues: { description: "no_issues", parameters: {}, to: "implementation_review" },
				},
			}),
			address_review: createFixtureLlmTurn("address_review", {
				turnEnd: { outcome: "comments_addressed", params: {}, to: "verify_build" },
			}),
			verify_build: createFixtureLlmTurn("verify_build", {
				turnEnd: undefined,
				outcomes: {
					build_failing: { description: "build_failing", parameters: {}, to: "fix_build" },
					build_passing: {
						description: "build_passing",
						parameters: {},
						to: "commit_and_complete",
					},
				},
			}),
			fix_build: createFixtureLlmTurn("fix_build", {
				turnEnd: { outcome: "build_fixed", params: {}, to: "verify_build" },
			}),
			commit_and_complete: createFixtureLlmTurn("commit_and_complete", {
				turnEnd: { outcome: "committed", params: {}, to: "implementation_review" },
			}),
			implementation_review: createFixtureHumanTurn({
				reviewSemanticRef: "review",
			}),
		},
	});
	const mrPolish = createFixtureProcess({
		id: "mr_polish_process",
		entry: "address_review",
		turns: {
			address_review: createFixtureLlmTurn("address_review", {
				turnEnd: { outcome: "comments_addressed", params: {}, to: "verify_build" },
			}),
			verify_build: createFixtureLlmTurn("verify_build", {
				turnEnd: undefined,
				outcomes: {
					build_failing: { description: "build_failing", parameters: {}, to: "fix_build" },
					build_passing: {
						description: "build_passing",
						parameters: {},
						to: "commit_and_complete",
					},
				},
			}),
			fix_build: createFixtureLlmTurn("fix_build", {
				turnEnd: { outcome: "build_fixed", params: {}, to: "verify_build" },
			}),
			commit_and_complete: createFixtureLlmTurn("commit_and_complete", {
				turnEnd: { outcome: "committed", params: {}, to: "mr_polish_review" },
			}),
			mr_polish_review: createFixtureHumanTurn({
				reviewSemanticRef: "review",
			}),
		},
	});
	return createProcessGraphRegistry([
		ticket as ExtensionProcessDefinition<unknown, unknown>,
		mrPolish as ExtensionProcessDefinition<unknown, unknown>,
	]);
}
