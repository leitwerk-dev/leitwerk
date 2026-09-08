import type { LaunchRun } from "@leitwerk-dev/domain";

/** Accepts a launch-run request shape and waits for its admitted process commit. */
export async function postImmediateLaunchRequest(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL(String(input));
	const match = /^\/api\/launchers\/([^/]+)\/launch-runs$/.exec(url.pathname);
	if (!match?.[1]) throw new Error(`Expected an immediate launch-run URL, received '${url}'`);
	const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
	return postImmediateLaunch(url.origin, decodeURIComponent(match[1]), body);
}

/**
 * Admits an immediate launch through the public asynchronous HTTP contract and waits until the
 * process commit or a pre-commit failure is observable. Intended for integration-test setup.
 */
export async function postImmediateLaunch(
	serverBaseUrl: string,
	launcherId: string,
	body: Record<string, unknown>,
): Promise<Response> {
	const admitted = await fetch(
		`${serverBaseUrl.replace(/\/$/, "")}/api/launchers/${encodeURIComponent(launcherId)}/launch-runs`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
			body: JSON.stringify({ ...body, schedule: { mode: "now" } }),
		},
	);
	const admittedBody = (await admitted.json()) as { launchRunId?: string };
	if (admitted.status !== 202 || !admittedBody.launchRunId) {
		return new Response(JSON.stringify(admittedBody), {
			status: admitted.status,
			headers: { "content-type": "application/json" },
		});
	}

	let launchRun: LaunchRun;
	const deadline = Date.now() + 10_000;
	for (;;) {
		const response = await fetch(
			`${serverBaseUrl.replace(/\/$/, "")}/api/launch-runs/${admittedBody.launchRunId}`,
		);
		const responseBody = (await response.json()) as { launchRun: LaunchRun };
		if (
			responseBody.launchRun.instanceId ||
			["failed", "cancelled"].includes(responseBody.launchRun.status)
		) {
			launchRun = responseBody.launchRun;
			break;
		}
		if (Date.now() >= deadline) throw new Error("Timed out waiting for immediate launch admission");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	if (!launchRun.instanceId) {
		const failure = launchRun.steps.find((step) => step.status === "failed");
		return new Response(
			JSON.stringify({
				error: failure?.safeSummary ?? "Launch failed",
				launchRunId: launchRun.id,
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}
	const detailResponse = await fetch(
		`${serverBaseUrl.replace(/\/$/, "")}/api/processes/${encodeURIComponent(launchRun.instanceId)}`,
	);
	const detail = (await detailResponse.json()) as { process: unknown; projects?: unknown[] };
	const failure = launchRun.steps.find((step) => step.status === "failed");
	return new Response(
		JSON.stringify({
			process: detail.process,
			projects: detail.projects ?? [],
			launchRunId: launchRun.id,
			...(launchRun.status === "failed"
				? { error: failure?.safeSummary ?? "Process was created, but startup failed" }
				: {}),
		}),
		{
			status: launchRun.status === "failed" ? 200 : 201,
			headers: { "content-type": "application/json" },
		},
	);
}
