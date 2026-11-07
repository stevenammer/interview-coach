CREATE TABLE model_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('paste','ingest','rep_extract','debrief','workspace_map')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  input_json jsonb NOT NULL,
  result_json jsonb,
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE(user_id,id)
);
CREATE INDEX model_jobs_owner ON model_jobs(user_id,created_at);
