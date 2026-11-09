# Session-to-token ownership inside authentication

## Status

Implemented. No design decision is open.

## Problem

`ownerForRequest` in `api-token-routes.ts` combines `request.actor` (from
`resolveSession`) with a separate `auth.userInformation(cookie)` read, then calls
`apiTokens.ownerForActor`, which reevaluates admission. The hook and each handler
call it, so one mutating request reads the session about five times.

Actor and evidence come from independent reads. If the session disappears between
them, `ownerForActor` receives `null` evidence and, under an evidence-dependent
policy, throws `Invalid token owner`: a 500 instead of a 401. `resolveSessionRecord`
in `auth-service.ts` already returns both from one read.

## Contract

- Authentication resolves the token owner from the browser session. Callers do not
  combine actor and evidence. A forwarding helper that only moves the combining
  code does not meet this contract.
- One operation returns `ApiTokenOwner | null` for a session cookie (name open,
  e.g. `tokenOwnerForSession`). It uses `resolveSessionRecord`. The hook sets
  `request.actor` from `owner.actor`; it does not call `resolveSession` separately.
- With authentication disabled, the operation returns the anonymous owner
  (`kind: "anonymous"`, `ADMIN_ACTOR`, no provider binding).
- `ownerForActor` leaves the public `ApiTokenService` interface. `userInformation`
  stays; `routes.ts` uses it.
- Ownership is resolved once per request and reused for that request's checks and
  operation. Each request resolves and validates again. Ownership is not cached
  across requests.
- The Fastify adapter keeps `Authorization`-header rejection and Origin/CSRF checks.
  The routes keep HTTP handling and the anonymous CSRF cookie.
- Behavior is unchanged. No schema change. The contracts in `docs/security.md` hold:
  anonymous ownership, current-policy admission, provider binding, and independent
  token lifetime.

## Request-local storage

Store the owner in a `WeakMap<FastifyRequest, ApiTokenOwner>` private to
`registerApiTokenRoutes`. The hook writes it; handlers read it.

Do not add an owner field to `FastifyRequest`. Module augmentation is server-wide,
and `ApiTokenOwner.oidcEvidence` holds ID-token and UserInfo claims. Claims stay
off actors and off the general request. Only `request.actor` belongs there.
`98268bd3` removed a general `request.authentication` context; do not restore it.

## Out of scope

- Login claim interpretation (`handoff-login-claim-interpretation.md`)
- Route classification and auditing
- A general authentication context or credential module
- UI work

## Starting points

Reviewed at `b766ec45` after `a1746173` (#224). Read the current source first.

- `packages/server/src/auth/api-token-routes.ts`
- `packages/server/src/auth/auth-service.ts`
- `packages/server/src/auth/api-token-service.ts`
- `packages/server/src/auth/fastify-auth.ts`

## Validation

Existing observable tests must pass. Do not assert helper calls or lookup counts.

Missing coverage: policy reevaluation through the HTTP token routes. Admission
policy is read when `createAuthService` runs, so a policy change needs a second
server over the same `repos`. `oidc-access.test.ts` already does this at the
service level. Add an HTTP scenario: log in, issue a token, start a second server
with a stricter policy over the shared `repos`, and verify that token management
and bearer use are denied. Use the shared in-memory `repos`; do not add a
file-backed reopen.

Do not repeat the claims plan's scenario with differing ID-token and UserInfo
claims. If that plan lands first, reuse its login fixture.

Rebuild before Vitest. Run `npm run test:full`. Update shared docs only if a
contract changes. Do not commit or open a pull request unless asked.

## Coordination

The claims plan edits `completeLogin` in `auth-service.ts`. Neither plan changes
`OidcEvidence` or storage. Implement them one after the other, not on parallel
branches.

## References

- [Visual report](oidc-authentication-review/report.html)
- [Astra review](oidc-authentication-review/astra-review.md)
- [Sol review](oidc-authentication-review/sol-review.md)
- `AGENTS.md`, `WRITING.md`, `docs/security.md`, `docs/ubiquitous_language.md`

The reviews describe `b766ec45`. If more sub-agent exploration is needed, use
fresh Pi instances with Astra or Sol. Leave the untracked `cop.log` untouched.

Suggested skills: **codebase-design** for interface depth; **code-review** after
implementation; **grilling** only if new evidence reopens a decision;
**domain-modeling** only if a term changes.
