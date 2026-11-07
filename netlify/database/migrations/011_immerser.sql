-- Replace cards created from internal predicate labels. They can be rebuilt as story cards.
UPDATE drill_cards SET status='invalidated' WHERE cue LIKE 'Recall the % beat';
CREATE TABLE verified_company_facts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  quote text NOT NULL, source_url text NOT NULL, checked_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','retired')),
  UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE,
  CHECK (source_url LIKE 'https://%')
);
CREATE INDEX company_facts_owner ON verified_company_facts(user_id,workspace_id);
CREATE TABLE immersions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  plan_json jsonb NOT NULL, state_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE
);
CREATE INDEX immersions_owner ON immersions(user_id,workspace_id,updated_at DESC);
ALTER TABLE model_jobs DROP CONSTRAINT model_jobs_kind_check;
ALTER TABLE model_jobs ADD CONSTRAINT model_jobs_kind_check CHECK
  (kind IN ('paste','ingest','rep_extract','debrief','workspace_map','immerse_week'));
