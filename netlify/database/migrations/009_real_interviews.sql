CREATE TABLE real_interviews (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  capture_kind text NOT NULL CHECK (capture_kind IN ('voice','notes','transcript')),
  source_id uuid NOT NULL, questions_json jsonb NOT NULL,
  story_fact_ids_json jsonb NOT NULL, stumped_json jsonb NOT NULL,
  asked_count integer NOT NULL, matched_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,source_id) REFERENCES sources(user_id,id) ON DELETE CASCADE
);
CREATE INDEX real_interviews_owner ON real_interviews(user_id,workspace_id);
