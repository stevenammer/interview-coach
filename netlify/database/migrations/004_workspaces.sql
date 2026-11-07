ALTER TABLE interviews ADD COLUMN plan_version integer NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN remote_preference text;
ALTER TABLE workspaces ADD COLUMN listing_work_mode text;
ALTER TABLE workspaces ADD COLUMN role_pack_version integer NOT NULL DEFAULT 1;
CREATE TABLE requirements (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  span_id uuid NOT NULL, text text NOT NULL,
  type text NOT NULL CHECK (type IN ('must','preferred','responsibility')),
  competency text NOT NULL, evidence_needed text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,span_id) REFERENCES source_spans(user_id,id)
);
CREATE INDEX requirements_owner ON requirements(user_id,workspace_id);
CREATE TABLE requirement_matches (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, requirement_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('direct','adjacent','none')),
  rationale text NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), UNIQUE(user_id,requirement_id),
  FOREIGN KEY (user_id,requirement_id) REFERENCES requirements(user_id,id) ON DELETE CASCADE
);
CREATE TABLE requirement_match_facts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, match_id uuid NOT NULL, fact_id uuid NOT NULL,
  FOREIGN KEY (user_id,match_id) REFERENCES requirement_matches(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,fact_id) REFERENCES facts(user_id,id)
);
