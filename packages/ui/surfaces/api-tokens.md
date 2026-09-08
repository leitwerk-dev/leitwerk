# API tokens surface

Implemented at `/account/api-tokens` in [ApiTokensPage.svelte](../src/pages/ApiTokensPage.svelte), reached through the account menu in [Sidebar.svelte](../src/shell/Sidebar.svelte). This surface applies the existing [design system](../DESIGN.md) and [product principles](../PRODUCT.md).

## Purpose

Operators create credentials for HTTP API clients, save a new secret, inspect token metadata, and revoke access. The introduction states that tokens grant full application HTTP API access as their owner and that browser logout does not revoke them. Anonymous access names the shared owner and explains that every visitor can view and revoke every anonymous token. There are no resource or action grant selectors.

## Layout

Use Public Sans, the chronicle palette, and existing spacing and type tokens. The centered white page has a maximum width of 900px. Identity and explanatory copy precede the creation form, then the token list. Horizontal dividers separate sections and rows. A restrained blue primary button marks creation; danger text identifies revocation. Temporary secret and revoke-all confirmation panels use local muted and danger surfaces.

The creation form is a single column with a maximum width of 480px. Fields and buttons have a minimum height of 44px. The name has a visible label; expiration offers the configured default, a local date and time, 30 minutes when within policy, and no expiration when allowed. The helper text states the maximum dated lifetime.

Each metadata row presents the name and a textual Active, Expired, or Revoked state, followed by the display prefix and public ID. Created, Expires, Last used, and, when applicable, Revoked values use a definition list with tabular numerals. Missing expiry reads “No expiration”; missing use reads “Never.” Long names and identifiers wrap. Metadata columns fit the available width with a 180px minimum, collapsing naturally on narrow screens. Heading and action groups wrap; below 600px, page and secret-panel padding become more compact.

## Secret and focus transition

Creation inserts the new metadata row and a “Save your token now” panel above the form. After rendering, focus moves to that heading and the panel scrolls into view. The heading describes the once-only instruction for assistive technology. Creation fields remain disabled while a secret is present, so another creation cannot replace an unsaved secret.

The secret is a readonly, selectable monospace textarea. Copy is explicit and reports success or a manual-copy fallback through a status message. “I saved it — dismiss” clears the secret and copy feedback, then restores focus to Name. Leaving the page or a page-hide event clears the temporary secret; reloading cannot retrieve it. The display is component-local state and does not persist the secret in browser storage.

## States and recovery

- Initial loading uses an announced “Loading tokens…” message. A failed initial request shows an alert and Try again. Refresh lets operators reload metadata.
- The empty list explains that a token connects an HTTP API client. Disabled issuance replaces the form with an explanation while retaining the list and revocation controls.
- Required name and date fields use native validation; a whitespace-only name cannot submit. Validation and request failures appear as text alerts. A pending mutation disables mutation controls and creation shows “Working…”.
- Individual revocation has an accessible name identifying the token. Successful revocation announces the outcome and reloads metadata. Revoked rows retain their metadata and omit the revoke action.
- Revoke all reveals an inline confirmation naming the current owner scope. It explains that clients lose access while accepted work and schedules continue. Confirm and Cancel remain visible; a failed revocation reports an alert for recovery.

## Account entry

The footer account menu exposes API tokens and Show help in both authentication modes. Authenticated users see their display name, falling back to the actor ID, and a logout action. Anonymous visitors see “Anonymous” and no logout. The same account actions remain available in the collapsed sidebar and mobile navigation drawer.
