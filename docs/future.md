# Future work

These capabilities are outside the supported scope. Listing them is not a delivery
commitment. Promote a capability only with an explicit contract and implementation.

- **Authorization:** Per-process permissions and tenant isolation. Current login and
  API tokens grant application-wide access with attribution.
- **Process creation:** Arbitrary process-to-process spawning. The operator-initiated
  ticket draft flow is a constrained exception, not a general spawning API.
- **Configuration-defined workflows:** Turns, transitions, and action behavior remain code-defined.
- **Arbitrary UI plugins:** Extensions may use bounded result-rendering slots; they do
  not replace shell navigation or define independent application areas.
- **Ambient or repository Pi resources:** Automatic import of repository skills,
  prompts, extensions, or an operator's ambient Pi configuration. Managed installed
  skill selection is a separate supported workflow.
- **macOS sandboxing:** Local workers run as the host user.
- **Multi-server storage:** PostgreSQL and coordination across multiple servers.
- **Inbound local handover:** Sending a local agent session into Leitwerk for background
  execution. Export from Leitwerk to local Pi is already supported.
- **Action queueing:** Queuing future business actions on an existing process.
- **Quotas:** Rate, request, and storage quotas without a concrete deployment need.

## Emergency security releases (proposal)

Critical security fixes could use a maintainer-dispatched emergency patch release
without merging the pending Release Please PR. This path is not implemented;
stable publication currently requires a merged Release Please PR.

- Require an advisory reference and a reviewed security-fix PR merged into `main`,
  with Full validation and Conventional PR title and DCO passing for its exact SHA.
- Prepare a reviewable patch release from that SHA, updating all workspace versions,
  internal dependencies, lockfile, chart, changelog, and Release Please manifest
  together. Validate the resulting release commit, not just the original fix.
  Show all changes since the previous release; a release from `main` may include
  other merged work and must not be described as a security-only release.
- Require maintainer approval of that exact release commit through a protected
  environment. Record the advisory, approving workflow run, and source PR as an
  alternative release origin; do not disable origin verification globally.
- Reuse the stable publication checks, short-lived credentials, artifact coordinates,
  and conflict-safe retries. Serialize version allocation with normal releases to
  prevent two workflows publishing the same patch version.
- Reconcile release metadata into `main` and refresh the pending Release Please PR
  before allowing another release. The emergency tag and manifest must agree so
  Release Please does not reuse the version or repeat released changes.

Security fixes already bypass Renovate's cooldown. Until an emergency path exists,
maintainers can expedite the normal Release Please PR after merging the fix.
