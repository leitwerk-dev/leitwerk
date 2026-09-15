import { buildProcessLaunchersForTest } from "@leitwerk-dev/extension-runtime/testing";
import { forgejoIntegration } from "@leitwerk-dev/forgejo";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { ProcessWatcherDefinition } from "@leitwerk-dev/process-sdk";
import { woodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { vi } from "vitest";
import { createForgejoRepoChange } from "../index.js";
import { forgejoRepoChangeUiLauncherId, type LauncherDependencies } from "../launcher.js";

export function launcherFixture(profile = "team", config: unknown = {}, docker = false) {
	const value = createForgejoRepoChange({ docker });
	const repository = {
		id: 7,
		name: "garden",
		full_name: "examples/garden",
		owner: { login: "examples" },
		ssh_url: "ssh://git@forgejo.example/examples/garden.git",
		default_branch: "trunk",
		html_url: "https://forgejo.example/examples/garden",
	};
	const identity = {
		provider: "forgejo" as const,
		profile,
		login: "garden-bot",
		name: "Garden Bot",
		email: "garden-bot@forgejo.example",
	};
	const preflight = vi.fn<LauncherDependencies["gitSsh"]["preflight"]>(async () => ({ ok: true }));
	const dependencies: LauncherDependencies = {
		forgejo: {
			profiles: () => [profile],
			client: () =>
				({
					listRepositories: async () => [
						repository,
						{ ...repository, id: 8, name: "workshop", full_name: "examples/workshop" },
					],
					resolveGitIdentity: async () => identity,
				}) as never,
		},
		woodpecker: {
			client: (name) => {
				if (![profile, "ci"].includes(name)) throw new Error("unknown");
				return {} as never;
			},
		},
		gitSsh: { profiles: () => [profile, "writer"], preflight },
	};
	const stops: Array<() => void> = [];
	const api = {
		require: (token: unknown) =>
			token === forgejoIntegration
				? dependencies.forgejo
				: token === gitSshIntegration
					? dependencies.gitSsh
					: token === woodpeckerIntegration
						? dependencies.woodpecker
						: undefined,
		onStop: (stop: () => void) => stops.push(stop),
	};
	const configure = (config: unknown) => value.extension.setupServer?.(api as never, config);
	configure(config);
	const ui = buildProcessLaunchersForTest(value.process)?.launchers.get(
		forgejoRepoChangeUiLauncherId,
	)?.ui;
	let watcher: ProcessWatcherDefinition | undefined;
	value.process.watchers?.({
		watcher: (value) => {
			watcher = value as ProcessWatcherDefinition;
		},
	});
	if (!ui || !watcher) throw new Error("Missing launcher or watcher");
	return {
		...value,
		dependencies,
		preflight,
		repository,
		identity,
		ui,
		watcher,
		configure,
		stop: () => {
			for (const stop of stops) stop();
		},
		launch: (input: Record<string, unknown> = {}) =>
			ui.resolveLaunchConfig(
				{
					forgejoProfile: profile,
					repository: repository.full_name,
					prompt: "Document watering",
					...input,
				},
				{},
			),
	};
}
