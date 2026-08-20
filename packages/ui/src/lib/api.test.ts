import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiResponseError,
	fetchAuthMeWithRetry,
	fetchFutureExecution,
	logout,
	registerSkill,
	submitQuestionAnswers,
} from "./api.js";

const CONFIG_KEY = Symbol.for("leitwerk.uiRuntimeTransportConfig");
type GlobalWithConfig = typeof globalThis & {
	[CONFIG_KEY]?: { fetchImpl: typeof fetch };
};

afterEach(() => {
	delete (globalThis as GlobalWithConfig)[CONFIG_KEY];
});

describe("fetchAuthMeWithRetry", () => {
	it("recovers from temporary proxy failures", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 502 }))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						authEnabled: false,
						actor: { id: "admin", kind: "user", provider: null },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			);
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};
		const retries: number[] = [];

		const result = await fetchAuthMeWithRetry({
			maxAttempts: 3,
			sleep: async () => {},
			onRetry: (_error, attempt) => retries.push(attempt),
		});

		expect(result.actor?.id).toBe("admin");
		expect(retries).toEqual([1, 2]);
	});

	it("does not retry non-transient HTTP failures", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};

		await expect(
			fetchAuthMeWithRetry({ maxAttempts: 3, sleep: async () => {} }),
		).rejects.toMatchObject({ status: 500 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("logout", () => {
	it("posts to the logout endpoint", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};

		await logout();

		expect(fetchImpl).toHaveBeenCalledWith("/auth/logout", { method: "POST" });
	});

	it("preserves logout failures", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};

		await expect(logout()).rejects.toMatchObject({ status: 503 });
	});
});

describe("API errors", () => {
	it("preserves a skill registration conflict from the server", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "Skill 'review' has conflicting candidates" }), {
					status: 409,
				}),
		);
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};

		await expect(registerSkill("shared", "review")).rejects.toThrow(
			"Skill 'review' has conflicting candidates",
		);
	});

	it("preserves a question-submission error from the server", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: "Question request is no longer active" }), {
					status: 409,
				}),
		);
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};

		await expect(
			submitQuestionAnswers({ instanceId: "agt_1", requestId: "qst_1", draft: [] }),
		).rejects.toMatchObject({ message: "Question request is no longer active", status: 409 });
	});

	it("preserves a non-success HTTP status on the thrown error", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
		(globalThis as GlobalWithConfig)[CONFIG_KEY] = {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		};

		const error = await fetchFutureExecution("fut_missing").catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ApiResponseError);
		expect(error).toMatchObject({ status: 404 });
	});
});
