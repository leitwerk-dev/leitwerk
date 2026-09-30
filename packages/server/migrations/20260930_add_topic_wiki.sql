CREATE TABLE wiki_topics (
 id text PRIMARY KEY NOT NULL,
 key text NOT NULL,
 data text NOT NULL
);
CREATE TABLE wiki_pages (
 id text PRIMARY KEY NOT NULL,
 topic_id text NOT NULL REFERENCES wiki_topics(id),
 data text NOT NULL
);
CREATE TABLE wiki_revisions (
 id text PRIMARY KEY NOT NULL,
 page_id text NOT NULL REFERENCES wiki_pages(id),
 data text NOT NULL
);
CREATE TABLE topic_publications (
 key text PRIMARY KEY NOT NULL,
 topic_id text NOT NULL REFERENCES wiki_topics(id),
 external_id text,
 data text NOT NULL
);
CREATE UNIQUE INDEX idx_topic_publications_external ON topic_publications(external_id);
