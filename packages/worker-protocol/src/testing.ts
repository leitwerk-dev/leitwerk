import type { ConfigSnapshot } from "@leitwerk-dev/protocol/config-snapshot";

export function createTestConfigSnapshot(): ConfigSnapshot {
	return {
		workers: {
			heartbeat_interval: "5s",
			turn_max_duration: "30m",
			turn_inactivity_timeout: "5m",
			turn_abort_grace_period: "5s",
		},
		pi: {
			agent_dir: "~/.pi/leitwerk",
			model_profiles: [],
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
		},
	};
}
