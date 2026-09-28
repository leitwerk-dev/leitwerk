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

Allow maintainers to publish an emergency security patch without merging the
pending Release Please PR. This path is not implemented. Stable publication still
requires a merged Release Please PR, which maintainers can expedite after merging
a security fix.

An emergency release would require:

- An advisory reference and a reviewed security-fix PR merged into `main`, with
  **Full validation** and **Conventional PR title and DCO** passing for that commit.
- Validation and maintainer approval of the exact release commit through a
  protected environment. Release notes must cover all changes since the previous
  release, including other merged work.
- A verified release origin linking the advisory, source PR, and approving workflow
  run. Existing publication checks, credentials, artifact coordinates, and retry
  safeguards still apply.
- Coordinated versions and release metadata across packages, images, and the chart.
  Normal and emergency releases must not allocate the same version. Release metadata
  on `main` and the pending Release Please PR must reflect the emergency release
  before another release proceeds.
