import { LocalGit, readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";
import type { WoodpeckerClientLike } from "./capability.js";
import type { WoodpeckerPipeline, WoodpeckerRepository } from "./client.js";

export interface LocalWoodpeckerRepository {
	repository: WoodpeckerRepository;
	pipelines: Array<WoodpeckerPipeline & { logs: string }>;
}
export interface LocalWoodpeckerState {
	version: 1;
	sequence: number;
	repositories: LocalWoodpeckerRepository[];
}
export interface LocalWoodpeckerOptions {
	root: string;
	baseUrl: string;
	now?: () => number;
	nextId?: () => number;
}

/** Local CI state is independent of the repository's Git host. */
export class LocalWoodpeckerAdapter {
	state: LocalWoodpeckerState;
	constructor(readonly options: LocalWoodpeckerOptions) {
		new LocalGit(options.root);
		this.state = readLocalJson(options.root, "woodpecker.json", {
			version: 1,
			sequence: 0,
			repositories: [],
		});
	}
	save() {
		writeLocalJson(this.options.root, "woodpecker.json", this.state);
	}
	id() {
		this.state.sequence = Math.max(this.state.sequence + 1, this.options.nextId?.() ?? 0);
		return this.state.sequence;
	}
	seed(fullName: string, id?: number) {
		const existing = this.state.repositories.find((r) => r.repository.full_name === fullName);
		if (existing) return existing;
		const repo = { repository: { id: id ?? this.id(), full_name: fullName }, pipelines: [] };
		this.state.sequence = Math.max(this.state.sequence, repo.repository.id);
		this.state.repositories.push(repo);
		this.save();
		return repo;
	}
	publish(
		repo: LocalWoodpeckerRepository,
		input: { branch: string; commit: string; status: string; logs: string; event?: string },
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
			id: number,
			number,
			event: input.event ?? "push",
			created_at: Math.floor((this.options.now?.() ?? Date.now()) / 1000),
			workflows: [
				{ id: 1, name: "local", steps: [{ id: 1, name: "validation", state: input.status }] },
			],
		};
		repo.pipelines.push(pipeline);
		this.save();
		return pipeline;
	}
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
				const lines = original
					.split("\n")
					.slice(-Math.min(2000, Math.max(1, tail)))
					.join("\n");
				const encoded = Buffer.from(lines),
					limit = Math.min(1048576, Math.max(1, bytes));
				let start = Math.max(0, encoded.length - limit);
				while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
				const logs = encoded.subarray(start).toString("utf8");
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
