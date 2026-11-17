// Additive schema, applied as one versioned transaction.
export const schema = `
CREATE TABLE delegation_block (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL
) STRICT;
CREATE INDEX delegation_block_note ON delegation_block(note_id);

CREATE TABLE delegation_session (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (length(external_id) > 0),
  UNIQUE (agent_id, external_id),
  UNIQUE (id, agent_id)
) STRICT;

CREATE TABLE delegation_binding (
  block_id TEXT PRIMARY KEY REFERENCES delegation_block(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES delegation_session(id)
) STRICT;

CREATE TABLE delegation_run (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES delegation_block(id),
  agent_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  source_revision TEXT NOT NULL,
  source_line INTEGER NOT NULL CHECK (source_line > 0),
  mode TEXT NOT NULL CHECK (mode IN ('new', 'resume')),
  target_session_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('reserved', 'dispatching', 'bound', 'finished', 'cancelled')),
  dispatch_id TEXT UNIQUE,
  session_id TEXT,
  receipt_ref TEXT,
  completion_ref TEXT,
  UNIQUE (id, block_id),
  FOREIGN KEY (target_session_id, agent_id) REFERENCES delegation_session(id, agent_id),
  FOREIGN KEY (session_id, agent_id) REFERENCES delegation_session(id, agent_id),
  CHECK ((mode = 'resume') = (target_session_id IS NOT NULL)),
  CHECK ((dispatch_id IS NOT NULL) = (phase IN ('dispatching', 'bound', 'finished'))),
  CHECK ((session_id IS NOT NULL) = (phase IN ('bound', 'finished'))),
  CHECK ((receipt_ref IS NOT NULL) = (session_id IS NOT NULL)),
  CHECK ((completion_ref IS NOT NULL) = (phase = 'finished')),
  CHECK (mode = 'new' OR session_id IS NULL OR target_session_id = session_id),
  UNIQUE (session_id, receipt_ref),
  UNIQUE (session_id, completion_ref)
) STRICT;

CREATE UNIQUE INDEX delegation_one_live_run
  ON delegation_run(block_id) WHERE phase IN ('reserved', 'dispatching', 'bound');

CREATE TABLE delegation_intent (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('owner', 'coalesced', 'active-conflict')),
  source_hash TEXT CHECK (length(source_hash) = 64),
  FOREIGN KEY (run_id, block_id) REFERENCES delegation_run(id, block_id)
) STRICT;

CREATE UNIQUE INDEX delegation_one_run_owner
  ON delegation_intent(run_id) WHERE outcome = 'owner';
`
