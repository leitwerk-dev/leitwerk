# External writes

Use the process-bound `ExternalWrites` capability to reconcile a remote write:
`ensure` recovers an existing object, executes only when needed, and records
durable metadata. Use `logOnly` for operations without a recoverable remote
object. External-write identities and operation contracts are exported from the
package root; storage helpers remain internal.
