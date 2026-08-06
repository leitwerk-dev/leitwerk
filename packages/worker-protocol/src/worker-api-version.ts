/**
 * Compatibility version for the server ↔ worker runtime API.
 *
 * Container image labels use the same value (`leitwerk.dev/worker-api-version`).
 * Workers also report it in `worker.hello` so the server can fail fast when a
 * pod image is from an incompatible leitwerk build line.
 */
export const WORKER_API_VERSION = "2026-07-26";
