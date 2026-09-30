# Solution wiki surface

Mode: Operate / Read. Implemented at `/wiki`, `/wiki/:topicId`, and
`/wiki/:topicId/:pageId` in [WikiPage.svelte](../src/pages/WikiPage.svelte).
The surface follows the existing [design system](../DESIGN.md) and
[product principles](../PRODUCT.md).

## Purpose and direction

Operators browse shared solutions and lessons scoped to an epic, check whether
guidance applies, inspect its evidence and origin, and remove obsolete entries.
The introduction asks readers to check cited evidence before applying guidance.
Solution wikis is available in global navigation; associated processes link to
their wiki. Topic navigation provides All solution wikis and Open epic.

## Composition

Use Public Sans, the chronicle palette, existing spacing tokens, and shared
`ui-button` controls. The centered white page has a maximum width of 1200px.
The shared page header presents the topic title, explanatory copy, and Refresh.
The top-level index is a flat list of topic links separated by thin dividers.

A topic uses two columns: an entry index between 220px and 280px wide and a
reader capped at 75ch. Find an entry searches titles, applicability, and entry
text without case sensitivity. Evidence status offers All entries, Needs
revalidation, Proposed, Observed, and Validated. Index rows show the title and
written evidence status. The selected row has a restrained accent tint and an
`aria-current` marker. Filtering changes the index while preserving the selected
entry in the reader.

Keep the composition flat. Dividers separate index rows and history revisions;
muted surfaces group revalidation guidance, deletion confirmation, and code
blocks. Links and visible focus outlines use the inherited operational accent.

## Reading and provenance

The reader begins with the entry title, evidence status, revision, and update
time. Validated is written as “Validated against cited evidence.” Needs
revalidation adds an explicit notice that evidence or a linked entry changed
and the guidance must be revalidated before reuse.

Applies when precedes the entry's Markdown. Evidence follows with repository,
path, revision, and observation. A Contributing process link and source turn
identify the origin. Related entries link within the topic; a missing related
entry explains that dependent guidance needs review.

Show revision history loads history beneath the entry actions. Each revision
uses a native disclosure with its revision number and timestamp in the summary
and its saved Markdown inside. History remains part of the reading flow.

## States and recovery

- Initial loading uses an announced “Loading solution wiki…” message. Refresh
  reports “Refreshing…” while pending. Index and topic request failures show an
  alert with Try again. The empty index appears only after a successful load;
  it explains how a process can share findings with a topic.
- An empty topic says “No shared findings yet.” An unmatched filter says
  “No entries match these filters.” With no selected entry, the reader explains
  what to select; an unavailable entry directs readers back to the index.
- A history failure stays beside the history action with Retry history. The
  selected entry remains readable, and loading history disables its action.
- Delete entry opens an inline confirmation naming the entry. It explains that
  deletion removes browsing and future agent access but cannot erase context
  already read by a running agent. Confirm and Cancel remain visible; both are
  disabled while deletion is pending.
- A deletion failure stays inside the confirmation with Retry deletion. A
  revision conflict instead offers Refresh entry before deleting, requiring
  fresh entry data before another confirmation. Successful deletion returns to
  the topic index. History and deletion feedback clear when selection changes.

Refresh, relevant wiki updates, and a restored connection reload the current
index or topic.

## Responsive behavior

At 760px and below, the index and reader form one column in that order, with
more compact page padding. The existing mobile shell supplies navigation.
Breadcrumbs and entry actions wrap. Long titles, identifiers, and evidence wrap;
code blocks scroll horizontally within their own surface. Search and status
controls retain a minimum height of 44px. Native history disclosures and visible
focus outlines preserve keyboard access throughout the reading flow.
