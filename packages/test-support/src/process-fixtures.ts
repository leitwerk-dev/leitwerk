import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import {
	createTestProcessInstance,
	createTestProcessProject,
} from "@leitwerk-dev/extension-runtime/testing";
import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";

/** Business position for an unaccepted fixture. @public */
export interface ProcessFixturePosition {
	/** @public */
	selectedTurnId: string | null;
	/** @public */
	lifecycleStatus: ProcessInstance["lifecycleStatus"];
}

/** Inputs deliberately exclude execution and acceptance records. @public */
export interface ProcessFixtureOptions<TParams = unknown, TState = unknown> {
	/** @public */
	id?: string;
	/** @public */
	processId?: string;
	/** @public */
	params?: TParams;
	/** @public */
	state?: TState;
	/** @public */
	position?: ProcessFixturePosition;
	/** @public */
	title?: string | null;
	/** @public */
	externalId?: string | null;
	/** @public */
	externalUrl?: string | null;
	/** @public */
	metadata?: Record<string, unknown> | null;
	/** @public */
	planRevision?: number;
}

/** Construct deterministic business data, validating codecs and turns when defined. @public */
export function createProcessFixture<TParams = unknown, TState = unknown>(
	options: ProcessFixtureOptions<TParams, TState> = {},
	definition?: ExtensionProcessDefinition<TParams, TState>,
): ProcessInstance {
	if (
		options.planRevision !== undefined &&
		(!Number.isSafeInteger(options.planRevision) || options.planRevision < 0)
	)
		throw new Error("planRevision must be a non-negative safe integer");
	if (definition && options.processId && options.processId !== definition.id) {
		throw new Error("Fixture process id does not match definition");
	}
	const params = definition ? definition.paramsCodec.parse(options.params) : options.params;
	const state = definition
		? definition.stateCodec.parse(
				options.state === undefined ? definition.initialState(params as TParams) : options.state,
			)
		: options.state;
	const position = options.position ?? {
		selectedTurnId: definition?.entryTurnId ?? null,
		lifecycleStatus: definition ? "active" : "discovered",
	};
	if (
		definition &&
		position.selectedTurnId !== null &&
		!definition.turns.has(position.selectedTurnId)
	) {
		throw new Error(`Undeclared fixture turn '${position.selectedTurnId}'`);
	}
	return createTestProcessInstance({
		id: options.id ?? "agt_test",
		processId: definition?.id ?? options.processId ?? "test_process",
		title: options.title ?? null,
		externalId: options.externalId ?? null,
		externalUrl: options.externalUrl ?? null,
		metadata: structuredClone(options.metadata ?? null),
		planRevision: options.planRevision ?? 0,
		selectedTurnId: position.selectedTurnId,
		lifecycleStatus: position.lifecycleStatus,
		paramsJson:
			params === undefined
				? null
				: JSON.stringify(definition ? definition.paramsCodec.serialize(params as TParams) : params),
		stateJson:
			state === undefined
				? null
				: JSON.stringify(definition ? definition.stateCodec.serialize(state as TState) : state),
	});
}

/** Repository business data; ownership comes from the supplied process. @public */
export interface ProjectFixtureOptions {
	/** Provider-owned repository bindings. @public */
	metadata?: Record<string, unknown> | null;
	/** @public */
	id?: string;
	/** @public */
	process?: Pick<ProcessInstance, "id">;
	/** @public */
	key?: string;
	/** @public */
	repoLocator?: string;
	/** @public */
	repoLocatorKind?: ProcessProject["repoLocatorKind"];
	/** @public */
	baseBranch?: string;
	/** @public */
	workBranch?: string | null;
}

/** Construct a deterministic repository fixture correlated with its process. @public */
export function createProjectFixture(options: ProjectFixtureOptions = {}): ProcessProject {
	return createTestProcessProject({
		id: options.id ?? `prj_${options.key ?? "test"}`,
		metadata: structuredClone(options.metadata ?? null),
		instanceId: options.process?.id ?? "agt_test",
		key: options.key ?? "component-a",
		repoLocator: options.repoLocator ?? "https://example.invalid/component-a.git",
		repoLocatorKind: options.repoLocatorKind ?? "remote_url",
		baseBranch: options.baseBranch ?? "main",
		workBranch: options.workBranch ?? null,
	});
}
