import { LocalProviderStore } from "@leitwerk-dev/test-support/local-git";
import type { WoodpeckerClientLike } from "./capability.js";
import type { WoodpeckerPipeline, WoodpeckerRepository } from "./client.js";
import { boundedLogTail } from "./logs.js";

/** @public */
export interface LocalWoodpeckerRepository {
	/** @public */
	repository: WoodpeckerRepository;
	/** @public */
	pipelines: Array<
		WoodpeckerPipeline & {
			/** @internal */
			logs: string;
			/** @internal */
			controlKey?: string;
		}
	>;
}
/** @public */
export interface LocalWoodpeckerState {
	/** @public */
	version: 1;
	/** @public */
	sequence: number;
	/** @public */
	repositories: LocalWoodpeckerRepository[];
}
/** @public */
export interface LocalWoodpeckerOptions {
	/** @public */
	root: string;
	/** @public */
	baseUrl: string;
	/** @public */
	now?: () => number;
	/** @public */
	nextId?: () => number;
}

/** Local CI state is independent of the repository's Git host. */
/** @public */
export class LocalWoodpeckerAdapter extends LocalProviderStore<
	LocalWoodpeckerState,
	LocalWoodpeckerOptions
> {
	/** @public */
	constructor(options: LocalWoodpeckerOptions) {
		super(options, "woodpecker.json", {
			version: 1,
			sequence: 0,
			repositories: [],
		});
	}
	/** @public */
	seed(fullName: string, id?: number) {
		const existing = this.state.repositories.find((r) => r.repository.full_name === fullName);
		if (existing) return existing;
		const repo = { repository: { id: id ?? this.id(), full_name: fullName }, pipelines: [] };
		this.state.sequence = Math.max(this.state.sequence, repo.repository.id);
		this.state.repositories.push(repo);
		this.save();
		return repo;
	}
	/** @public */
	publish(
		repo: LocalWoodpeckerRepository,
		input: {
			/** @public */
			branch: string;
			/** @public */
			commit: string;
			/** @public */
			status: string;
			/** @public */
			logs: string;
			/** @internal */
			event?: string;
			/** @internal */
			controlKey?: string;
		},
	) {
		if (
			![
				"pending",
				"running",
				"success",
				"failure",
				"error",
				"killed",
				"canceled",
				"cancelled",
				"declined",
				"blocked",
			].includes(input.status)
		)
			throw new Error("Invalid pipeline status");
		const number = this.id();
		const pipeline = {
			...input,
			/** @internal */
			id: number,
			/** @public */
			number,
			/** @internal */
			event: input.event ?? "push",
			/** @internal */
			created_at: Math.floor((this.options.now?.() ?? Date.now()) / 1000),
			/** @internal */
			workflows: [
				{
					/** @internal */
					id: 1,
					/** @internal */
					name: "local",
					/** @internal */
					steps: [
						{
							/** @internal */
							id: 1,
							/** @internal */
							name: "validation",
							/** @internal */
							state: input.status,
						},
					],
				},
			],
		};
		repo.pipelines.push(pipeline);
		this.save();
		return pipeline;
	}
	/** @public */
	client(): WoodpeckerClientLike {
		const repo = (id: number) => {
			const value = this.state.repositories.find((r) => r.repository.id === id);
			if (!value) throw new Error("Unknown local CI repository");
			return value;
		};
		const pipeline = (id: number, number: number) => {
			const value = repo(id).pipelines.find((p) => p.number === number);
			if (!value) throw new Error("Unknown local pipeline");
			return value;
		};
		return {
			profile: { baseUrl: this.options.baseUrl, token: "" },
			lookupRepository: async (name) => {
				const value = this.state.repositories.find((r) => r.repository.full_name === name);
				if (!value) throw new Error("Unknown local CI repository");
				return structuredClone(value.repository);
			},
			listPipelines: async (id, _signal, { page = 1, perPage = 100 } = { page: 1 }) =>
				structuredClone(
					[...repo(id).pipelines]
						.sort((a, b) => b.number - a.number)
						.slice((page - 1) * perPage, page * perPage),
				),
			getPipeline: async (id, number) => structuredClone(pipeline(id, number)),
			getStepLogs: async (id, number, _step, tail = 400, bytes = 262144) => {
				const original = pipeline(id, number).logs;
				const logs = boundedLogTail(original.split("\n"), tail, bytes);
				return { logs, truncated: logs !== original };
			},
			restartPipeline: async (id, number) => {
				const value = pipeline(id, number);
				value.status = "pending";
				this.save();
				return structuredClone(value);
			},
		};
	}
}
