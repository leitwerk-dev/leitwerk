const DEFAULT_UI_DEV_SERVER_PORT = 5173;
const MAX_PORT = 65_535;

export interface UiDevServerOptions {
	port: number;
	strictPort: boolean;
}

export function resolveUiDevServerOptions(
	env: Record<string, string | undefined> = process.env,
): UiDevServerOptions {
	const rawConfiguredPort = env.LEITWERK_UI_PORT?.trim();
	if (!rawConfiguredPort) {
		return {
			port: DEFAULT_UI_DEV_SERVER_PORT,
			strictPort: false,
		};
	}
	const parsedPort = Number.parseInt(rawConfiguredPort, 10);
	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > MAX_PORT) {
		throw new Error(`Invalid LEITWERK_UI_PORT value: ${rawConfiguredPort}`);
	}
	return {
		port: parsedPort,
		strictPort: true,
	};
}
