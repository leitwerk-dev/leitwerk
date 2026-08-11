import { describe, expect, it } from "vitest";
import { testAuthConfig } from "../auth/auth-test-helpers.js";
import { getDefaultConfig, sanitizeConfigForLogging, validateConfig } from "./config-loader.js";

function addTestModelProfiles(config: ReturnType<typeof getDefaultConfig>): void {
	config.pi.model_profiles = [
		{ id: "claude_fast", provider: "test", model_id: "fast" },
		{ id: "local_qwen", provider: "test", model_id: "local" },
	];
}

function kubernetesConfig(): ReturnType<typeof getDefaultConfig> {
	const config = getDefaultConfig();
	config.workers.runner = "kubernetes";
	config.worker_runtime_profiles = { generic: { image: "ghcr.io/example/generic:1" } };
	return config;
}

describe("validateConfig", () => {
	it("accepts a valid full config", () => {
		const config = getDefaultConfig();
		config.server.host = "0.0.0.0";
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toEqual([]);
	});

	it("defaults auth.enabled to false", () => {
		expect(getDefaultConfig().auth?.enabled).toBe(false);
	});

	it("starts with an empty stock model profile catalog", () => {
		expect(getDefaultConfig().pi.model_profiles).toEqual([]);
	});

	it("reports wrong types", () => {
		const errors = validateConfig({
			server: {
				port: "not-a-number",
				websocket: {
					toast_ttl: false,
				},
			},
			workers: {
				resume_on_boot: "yes",
				log_worker_events_to_stdout: "sometimes",
			},
		} as unknown as Record<string, unknown>);
		expect(errors.some((e) => e.includes("server.port"))).toBe(true);
		expect(errors.some((e) => e.includes("server.websocket.toast_ttl"))).toBe(true);
		expect(errors.some((e) => e.includes("workers.resume_on_boot"))).toBe(true);
		expect(errors.some((e) => e.includes("workers.log_worker_events_to_stdout"))).toBe(true);
	});

	it("accepts process Pi prompt template overrides", () => {
		const config = getDefaultConfig();
		config.process_configs = {
			test_process: {
				default_model_profile: undefined,
				pi: {
					system_prompt_template: "You are {{role}}",
					append_system_prompt_template: "Always explain your work",
				},
				turn_configs: {
					review: {},
				},
			},
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("accepts configured worker runtime profiles referenced by components and processes", () => {
		const config = getDefaultConfig();
		config.worker_runtime_profiles = {
			generic: { image: "ghcr.io/example/generic:1" },
			node22: { image: "ghcr.io/example/node22:1" },
		};
		config.workers.default_runtime_profile = "generic";
		config.components = {
			frontend: {
				repo: "git@x:fe.git",
				default_branch: "main",
				worker_runtime_profile: "node22",
			},
		};
		config.process_configs = {
			my_process: { turn_configs: {}, worker_runtime_profile: "generic" },
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects references to unknown worker runtime profiles", () => {
		const config = getDefaultConfig();
		config.worker_runtime_profiles = { generic: { image: "ghcr.io/example/generic:1" } };
		config.workers.default_runtime_profile = "missing-default";
		config.components = {
			frontend: {
				repo: "git@x:fe.git",
				default_branch: "main",
				worker_runtime_profile: "missing-component",
			},
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((e) =>
				e.includes(
					"Unknown worker runtime profile 'missing-default' at workers.default_runtime_profile",
				),
			),
		).toBe(true);
		expect(
			errors.some((e) =>
				e.includes(
					"Unknown worker runtime profile 'missing-component' at components.frontend.worker_runtime_profile",
				),
			),
		).toBe(true);
	});

	it("accepts Kubernetes runner config with default runtime profile", () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		config.worker_runtime_profiles = {
			generic: {
				image: "ghcr.io/example/leitwerk-worker:1",
				image_pull_policy: "IfNotPresent",
				resources: {
					limits: { cpu: "4", memory: "8Gi" },
				},
			},
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects Kubernetes runner config before pod creation when required wiring is missing", () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		config.worker_runtime_profiles = {};
		if (config.kubernetes) {
			config.kubernetes.server_url = "not-a-url";
			config.kubernetes.server_namespace = "Invalid_Namespace";
			config.kubernetes.process_namespace_prefix = "InvalidPrefix";
			config.kubernetes.api_server_url = "not-a-url";
			config.kubernetes.default_worker_runtime_profile = "missing";
		}

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors.some((e) => e.includes("kubernetes.server_url"))).toBe(true);
		expect(errors.some((e) => e.includes("kubernetes.server_namespace"))).toBe(true);
		expect(errors.some((e) => e.includes("kubernetes.process_namespace_prefix"))).toBe(true);
		expect(errors.some((e) => e.includes("kubernetes.api_server_url"))).toBe(true);
		expect(errors.some((e) => e.includes("at least one profile"))).toBe(true);
		expect(
			errors.some((e) =>
				e.includes(
					"Unknown worker runtime profile 'missing' at kubernetes.default_worker_runtime_profile",
				),
			),
		).toBe(true);
	});

	it("accepts IPv4 and IPv6 worker Pod host aliases", () => {
		const config = kubernetesConfig();
		if (config.kubernetes) {
			config.kubernetes.pod.host_aliases = [
				{ ip: "192.0.2.10", hostnames: ["model-api.example.test", "models.example.test"] },
				{ ip: "2001:db8::10", hostnames: ["model-api-v6.example.test"] },
			];
		}

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it.each([
		[[{ ip: "not-an-ip", hostnames: ["model-api.example.test"] }], "IPv4 or IPv6"],
		[[{ ip: "192.0.2.10", hostnames: [] }], "hostnames"],
		[[{ ip: "192.0.2.10", hostnames: ["Not a hostname"] }], "hostname"],
	] as const)("rejects malformed worker Pod host aliases", (hostAliases, expected) => {
		const config = kubernetesConfig();
		if (config.kubernetes) config.kubernetes.pod.host_aliases = hostAliases;

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([
			expect.stringContaining(expected),
		]);
	});

	it("rejects Kubernetes server namespaces that use the process namespace prefix", () => {
		const config = kubernetesConfig();
		if (config.kubernetes) {
			config.kubernetes.server_namespace = "leitwerk-process-system";
			config.kubernetes.process_namespace_prefix = "leitwerk-process-";
		}

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors.some((e) => e.includes("must be dedicated"))).toBe(true);
	});

	it("rejects Docker-in-Docker runtime profiles for Kubernetes runner", () => {
		const config = kubernetesConfig();
		config.worker_runtime_profiles.generic = {
			image: "ghcr.io/example/generic:1",
			dind: "privileged",
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some(
				(e) =>
					e.includes("worker_runtime_profiles.generic.dind is not supported") &&
					e.includes("kubernetes"),
			),
		).toBe(true);
	});

	it("rejects non-positive session snapshot byte limits", () => {
		const config = getDefaultConfig();
		config.workers.session_snapshot_max_size_bytes = -1;
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toContain(
			"workers.session_snapshot_max_size_bytes must be a positive safe integer",
		);
	});

	it("rejects Docker runner config without a worker runtime profile catalog and default", () => {
		const config = getDefaultConfig();
		config.worker_runtime_profiles = {};
		config.workers.default_runtime_profile = "";

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toContain(
			"worker_runtime_profiles must include at least one profile when workers.runner is 'docker'",
		);
		expect(errors).toContain(
			"workers.default_runtime_profile is required when workers.runner is 'docker'",
		);
	});

	it("allows local runner without image/profile selection requirements", () => {
		const config = getDefaultConfig();
		config.workers.runner = "local";
		config.worker_runtime_profiles = {};
		config.workers.default_runtime_profile = "";
		config.components = {
			frontend: {
				repo: "git@x:fe.git",
				default_branch: "main",
				worker_runtime_profile: "ignored-locally",
			},
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects privileged DinD opt-in when the host runtime does not enable it", () => {
		const config = getDefaultConfig();
		config.workers.default_runtime_profile = "nested";
		config.worker_runtime_profiles = {
			nested: { image: "ghcr.io/example/nested:1", dind: "privileged" },
		};
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((e) =>
				e.includes(
					"worker_runtime_profiles.nested.dind is 'privileged' but docker.dind.privileged",
				),
			),
		).toBe(true);
	});

	it("accepts privileged DinD opt-in when the host runtime enables it", () => {
		const config = getDefaultConfig();
		if (config.docker) {
			config.docker.dind = { privileged: true, sysbox: false };
		}
		config.workers.default_runtime_profile = "nested";
		config.worker_runtime_profiles = {
			nested: { image: "ghcr.io/example/nested:1", dind: "privileged" },
		};
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects sysbox DinD opt-in when the host runtime does not enable it", () => {
		const config = getDefaultConfig();
		config.workers.default_runtime_profile = "sysboxed";
		config.worker_runtime_profiles = {
			sysboxed: { image: "ghcr.io/example/sysboxed:1", dind: "sysbox" },
		};
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((e) =>
				e.includes("worker_runtime_profiles.sysboxed.dind is 'sysbox' but docker.dind.sysbox"),
			),
		).toBe(true);
	});

	it("rejects sysbox DinD opt-in when no host sysbox runtime is configured", () => {
		const config = getDefaultConfig();
		if (config.docker) {
			config.docker.dind = { privileged: false, sysbox: true };
		}
		config.workers.default_runtime_profile = "sysboxed";
		config.worker_runtime_profiles = {
			sysboxed: { image: "ghcr.io/example/sysboxed:1", dind: "sysbox" },
		};
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((e) =>
				e.includes(
					"worker_runtime_profiles.sysboxed.dind is 'sysbox' but docker.dind.sysbox_runtime",
				),
			),
		).toBe(true);
	});

	it("accepts sysbox DinD opt-in when enabled with a configured runtime", () => {
		const config = getDefaultConfig();
		if (config.docker) {
			config.docker.dind = { privileged: false, sysbox: true, sysbox_runtime: "sysbox-runc" };
		}
		config.workers.default_runtime_profile = "sysboxed";
		config.worker_runtime_profiles = {
			sysboxed: { image: "ghcr.io/example/sysboxed:1", dind: "sysbox" },
		};
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("accepts internal TLS with cert, key, https worker URL, and runner CA file", () => {
		const config = getDefaultConfig();
		config.internal_tls = {
			enabled: true,
			cert_file: "/etc/tls/server.crt",
			key_file: "/etc/tls/server.key",
		};
		if (config.docker) {
			config.docker.server_url = "https://leitwerk-server:8080";
			config.docker.server_ca_file = "/etc/tls/ca.crt";
		}
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects internal TLS client CA because worker client certificates are not wired", () => {
		const config = getDefaultConfig();
		config.internal_tls = {
			enabled: true,
			cert_file: "/etc/tls/server.crt",
			key_file: "/etc/tls/server.key",
			client_ca_file: "/etc/tls/clients.pem",
		};
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toContain(
			"internal_tls.client_ca_file is not supported for worker IPC yet; workers do not receive client certificate/key material",
		);
	});

	it("rejects enabled internal TLS missing cert and key files", () => {
		const config = getDefaultConfig();
		config.internal_tls = { enabled: true };
		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors.some((e) => e.includes("internal_tls.cert_file is required"))).toBe(true);
		expect(errors.some((e) => e.includes("internal_tls.key_file is required"))).toBe(true);
	});

	it("ignores internal TLS file requirements when disabled", () => {
		const config = getDefaultConfig();
		config.internal_tls = { enabled: false };
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects production worker TLS when the runner URL is not https or CA-backed", () => {
		const config = getDefaultConfig();
		config.internal_tls = {
			enabled: true,
			cert_file: "/etc/tls/server.crt",
			key_file: "/etc/tls/server.key",
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toContain("docker.server_url must use https when internal_tls.enabled is true");
		expect(errors).toContain(
			"docker.server_ca_file is required when internal_tls.enabled is true and workers.runner is 'docker'",
		);
	});

	it("accepts Kubernetes internal TLS when the in-cluster URL is https and a CA file is configured", () => {
		const config = kubernetesConfig();
		config.internal_tls = {
			enabled: true,
			cert_file: "/etc/tls/server.crt",
			key_file: "/etc/tls/server.key",
		};
		if (config.kubernetes) {
			config.kubernetes.server_url =
				"https://leitwerk-server.leitwerk-system.svc.cluster.local:8080";
			config.kubernetes.server_ca_file = "/etc/tls/ca.crt";
		}

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("rejects https worker URLs when the internal listener is not serving TLS", () => {
		const config = getDefaultConfig();
		if (config.docker) {
			config.docker.server_url = "https://leitwerk-server:8080";
		}

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toContain("docker.server_url must use http when internal_tls.enabled is false");
	});

	it("accepts pi retry overrides that defer provider timeout and retry count to SDK defaults", () => {
		const config = getDefaultConfig();
		config.pi.retry = {
			enabled: true,
			max_retries: 2,
			base_delay: "3s",
			provider: {
				timeout: null,
				max_retries: null,
				max_retry_delay: "90s",
			},
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it.each([
		["pi", "process_dir", "pi.process_dir was renamed to pi.agent_dir; move the configured value"],
		[
			"local_worker",
			"process_volume_root",
			"local_worker.process_volume_root was removed; remove the key because local workers use storage.process_workspaces_dir and storage.tree_files_dir directly",
		],
	] as const)("rejects legacy %s.%s with migration guidance", (section, key, message) => {
		const config = getDefaultConfig() as unknown as Record<string, unknown>;
		(config[section] as Record<string, unknown>)[key] = "legacy-value";

		expect(validateConfig(config)).toContain(message);
	});

	it("accepts a configured process title generation model profile and retry policy", () => {
		const config = getDefaultConfig();
		addTestModelProfiles(config);
		config.pi.process_title_generation.model_profile = "claude_fast";
		config.pi.process_title_generation.retry = {
			max_attempts: 4,
			base_delay: "3s",
			max_delay: "2m",
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("accepts model profiles that omit thinking_level", () => {
		const config = getDefaultConfig();
		config.pi.model_profiles = [
			{
				id: "title_fast",
				provider: "lmstudio",
				model_id: "qwen3.6-35b-a3b",
			},
		];
		config.pi.process_title_generation.model_profile = "title_fast";

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("accepts string provider_options and rejects non-string values", () => {
		const config = getDefaultConfig();
		config.pi.model_profiles = [
			{
				id: "profile",
				provider: "provider",
				model_id: "model",
				provider_options: { preferred_account: "team" },
			},
		];
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);

		(config.pi.model_profiles[0]?.provider_options as Record<string, unknown>).preferred_account =
			4;
		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("pi.model_profiles[0].provider_options.preferred_account"),
			]),
		);
	});

	it("rejects non-string thinking_level values when specified", () => {
		const errors = validateConfig({
			pi: {
				agent_dir: "~/.pi/leitwerk",
				process_title_generation: {
					model_profile: null,
					retry: {
						max_attempts: 6,
						base_delay: "5s",
						max_delay: "5m",
					},
				},
				retry: {
					enabled: true,
					max_retries: 3,
					base_delay: "2s",
					provider: {
						timeout: null,
						max_retries: null,
						max_retry_delay: "60s",
					},
				},
				model_profiles: [
					{
						id: "title_fast",
						provider: "lmstudio",
						model_id: "qwen3.6-35b-a3b",
						thinking_level: 123,
					},
				],
			},
		} as unknown as Record<string, unknown>);

		expect(errors.some((error) => error.includes("pi.model_profiles[0].thinking_level"))).toBe(
			true,
		);
	});

	it("rejects an invalid process title generation retry policy", () => {
		const config = getDefaultConfig();
		config.pi.process_title_generation.retry.max_attempts = 0;

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((error) => error.includes("pi.process_title_generation.retry.max_attempts")),
		).toBe(true);
	});

	it("rejects an unknown process title generation model profile", () => {
		const config = getDefaultConfig();
		config.pi.process_title_generation.model_profile = "missing_profile";

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((error) => error.includes("pi.process_title_generation.model_profile")),
		).toBe(true);
	});

	it("rejects a blank process title generation model profile", () => {
		const config = getDefaultConfig();
		config.pi.process_title_generation.model_profile = "";

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((error) =>
				error.includes("pi.process_title_generation.model_profile must be a non-empty string"),
			),
		).toBe(true);
	});

	it("accepts valid allowed_model_profiles", () => {
		const config = getDefaultConfig();
		addTestModelProfiles(config);
		config.process_configs = {
			test_process: {
				allowed_model_profiles: ["claude_fast", "local_qwen"],
				default_model_profile: "local_qwen",
				turn_configs: {},
			},
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toEqual([]);
	});

	it("rejects empty allowed_model_profiles array", () => {
		const config = getDefaultConfig();
		config.process_configs = {
			test_process: {
				allowed_model_profiles: [],
				turn_configs: {},
			},
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some((e) =>
				e.includes("process_configs.test_process.allowed_model_profiles must not be empty"),
			),
		).toBe(true);
	});

	it("rejects unknown profile in allowed_model_profiles", () => {
		const config = getDefaultConfig();
		addTestModelProfiles(config);
		config.process_configs = {
			test_process: {
				allowed_model_profiles: ["claude_fast", "unknown_profile"],
				turn_configs: {},
			},
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(
			errors.some(
				(e) =>
					e.includes("Unknown model profile 'unknown_profile'") &&
					e.includes("allowed_model_profiles"),
			),
		).toBe(true);
	});

	it("accepts an inherited default_model_profile outside allowed_model_profiles", () => {
		const config = getDefaultConfig();
		addTestModelProfiles(config);
		config.process_configs = {
			test_process: {
				allowed_model_profiles: ["local_qwen"],
				default_model_profile: "claude_fast",
				turn_configs: {},
			},
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toEqual([]);
	});

	it("accepts an inherited turn model_profile outside allowed_model_profiles", () => {
		const config = getDefaultConfig();
		addTestModelProfiles(config);
		config.process_configs = {
			test_process: {
				allowed_model_profiles: ["local_qwen"],
				default_model_profile: "local_qwen",
				turn_configs: {
					some_turn: {
						model_profile: "claude_fast",
					},
				},
			},
		};

		const errors = validateConfig(config as unknown as Record<string, unknown>);
		expect(errors).toEqual([]);
	});

	it("accepts removed inherited process and turn defaults", () => {
		const config = getDefaultConfig();
		addTestModelProfiles(config);
		config.process_configs = {
			test_process: {
				default_model_profile: "removed",
				turn_configs: { some_turn: { model_profile: "removed" } },
			},
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});

	it("keeps watcher configuration opaque until its extension source validates it", () => {
		const config = getDefaultConfig();
		config.process_configs = {
			poem_creator_process: {
				turn_configs: {},
				watchers: {
					create_poem: {
						custom_source_field: "extension-owned",
					} as never,
				},
			},
		};

		expect(validateConfig(config as unknown as Record<string, unknown>)).toEqual([]);
	});
});

describe("auth config validation", () => {
	function errorsFor(config: ReturnType<typeof getDefaultConfig>): string[] {
		return validateConfig(config as unknown as Record<string, unknown>);
	}

	function expectErrorContaining(errors: readonly string[], ...parts: string[]): void {
		expect(errors.some((error) => parts.every((part) => error.includes(part)))).toBe(true);
	}

	it("accepts a single Identity OIDC provider", () => {
		expect(errorsFor(testAuthConfig({ auth: { allowlist: [] } }))).toEqual([]);
	});

	it("accepts GitHub OAuth with organization membership authorization", () => {
		const config = getDefaultConfig();
		config.server.base_url = "https://leitwerk.example.test";
		config.auth = {
			enabled: true,
			providers: [
				{
					id: "github",
					kind: "oauth2",
					client_id: "client",
					client_secret: "secret",
					organization: "leitwerk-dev",
				},
			],
		};

		expect(errorsFor(config)).toEqual([]);
	});

	it("does not enable or validate provider wiring unless auth.enabled is true", () => {
		const config = testAuthConfig({
			baseUrl: "http://leitwerk.example.test",
			provider: {
				issuer: "http://identity.example.test",
				redirect_uri: "http://leitwerk.example.test/auth/callback",
			},
		});
		if (config.auth) delete config.auth.enabled;

		expect(errorsFor(config)).toEqual([]);
	});

	it("fails closed for enabled auth without a configured provider", () => {
		const errors = errorsFor(testAuthConfig({ auth: { providers: [] } }));

		expectErrorContaining(errors, "auth.providers", "one authentication provider");
	});

	it("rejects invalid auth provider URLs", () => {
		const errors = errorsFor(
			testAuthConfig({
				provider: { issuer: "not a url", redirect_uri: "/auth/callback" },
			}),
		);

		expectErrorContaining(errors, "auth.providers[0].issuer", "absolute https URL");
		expectErrorContaining(errors, "auth.providers[0].redirect_uri", "absolute https URL");
	});

	it("rejects relative server base URLs", () => {
		const config = getDefaultConfig();
		config.server.base_url = "/leitwerk";

		expectErrorContaining(errorsFor(config), "server.base_url", "absolute http(s) URL");
	});

	it("requires https URLs when auth is enabled", () => {
		const errors = errorsFor(
			testAuthConfig({
				baseUrl: "http://leitwerk.example.test",
				provider: {
					issuer: "http://identity.example.test",
					redirect_uri: "http://leitwerk.example.test/auth/callback",
				},
			}),
		);

		expectErrorContaining(errors, "server.base_url", "https");
		expectErrorContaining(errors, "auth.providers[0].issuer", "absolute https URL");
		expectErrorContaining(errors, "auth.providers[0].redirect_uri", "absolute https URL");
	});

	it.each([
		["localhost", "http://localhost:8080", "http://localhost:3000"],
		["IPv4 loopback", "http://127.0.0.1:8080", "http://127.0.0.1:3000"],
		["IPv6 loopback", "http://[::1]:8080", "http://[::1]:3000"],
	])("accepts %s http URLs when auth is enabled", (_name, baseUrl, issuer) => {
		expect(
			errorsFor(
				testAuthConfig({
					baseUrl,
					provider: { issuer, redirect_uri: new URL("/auth/callback", baseUrl).toString() },
				}),
			),
		).toEqual([]);
	});

	it("rejects invalid auth session durations", () => {
		const errors = errorsFor(testAuthConfig({ session: { ttl: "soon" } }));

		expectErrorContaining(errors, "auth.session.ttl", "positive duration");
	});
});

describe("sanitizeConfigForLogging", () => {
	it("redacts sensitive values and keeps non-sensitive fields readable", () => {
		const config = getDefaultConfig();
		config.notifications.all.url = "https://hooks.example.test/all";
		config.notifications.squad.routes.backend = {
			url: "https://hooks.example.test/backend",
		};
		config.auth = {
			enabled: true,
			providers: [
				{
					id: "identity",
					kind: "oidc",
					issuer: "https://identity.example.test",
					client_id: "client",
					client_secret: "secret-token",
				},
			],
			allowlist: ["alice"],
		};
		config.extensions = {
			ticket: {
				url: "https://ticket.example.test",
				api_token: "secret-token",
			},
			chatops: {
				webhook: {
					url: "https://hooks.example.test/chatops",
				},
			},
		};

		const sanitized = sanitizeConfigForLogging(config) as Record<string, unknown>;
		const notifications = sanitized.notifications as Record<string, unknown>;
		const auth = sanitized.auth as Record<string, unknown>;
		const authProviders = auth.providers as Array<Record<string, unknown>>;
		const extensions = sanitized.extensions as Record<string, unknown>;
		const allChannel = notifications.all as Record<string, unknown>;
		const squad = notifications.squad as Record<string, unknown>;
		const squadRoutes = squad.routes as Record<string, unknown>;
		const ticket = extensions.ticket as Record<string, unknown>;
		const chatops = extensions.chatops as Record<string, unknown>;

		expect((sanitized.server as Record<string, unknown>).base_url).toBe("http://127.0.0.1:8080");
		expect(authProviders[0]?.issuer).toBe("https://identity.example.test");
		expect(authProviders[0]?.client_secret).toBe("<redacted>");
		expect(allChannel.url).toBe("<redacted>");
		expect((squadRoutes.backend as Record<string, unknown>).url).toBe("<redacted>");
		expect(ticket.url).toBe("https://ticket.example.test");
		expect(ticket.api_token).toBe("<redacted>");
		expect(chatops.webhook).toBe("<redacted>");
	});
});
