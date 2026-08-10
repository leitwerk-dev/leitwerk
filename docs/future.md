# Future Directions

- **Local Handover:** Handing over local agent sessions (Pi, Cursor, Codex, Claude) directly to Leitwerk server workers for background execution.
- **PostgreSQL Storage:** Supporting external databases like PostgreSQL beyond SQLite for multi-server deployments.
- **Action Queuing:** Queuing upcoming actions for process instances.
- **Granular Authorization:** Per-process authorization policies, tenant isolation, and audit reporting.
- **Process-to-Process Creation:** Processes spawning other process instances as a first-class product feature.
- **Config-Defined Processes:** Declaring process types, turn graphs, or action behavior in configuration rather than code-defined extensions.
- **Arbitrary Process-Defined UI Plugins:** Unbounded process-authored UI plugins beyond the current extension UI manifest / custom-element renderer model.
- **macOS Sandboxing:** Host sandbox profiles for worker or server isolation on macOS.
- **Rate / Request / Storage Quotas:** Rate limiting, request quotas, or storage quotas without a concrete multi-tenant need; current deployments are semi-trusted.
