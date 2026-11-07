CREATE TABLE coach_notes (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid, interview_id uuid, text text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,interview_id) REFERENCES interviews(user_id,id) ON DELETE SET NULL
);
CREATE INDEX coach_notes_owner ON coach_notes(user_id,workspace_id,active);

CREATE TABLE prep_packs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, input_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,workspace_id), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE
);
CREATE TABLE prep_pack_sections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, prep_pack_id uuid NOT NULL,
  section_key text NOT NULL, title text NOT NULL, kind text NOT NULL CHECK (kind IN ('deterministic','model')),
  input_hash text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','stale')),
  content_json jsonb, error_code text, job_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,prep_pack_id,section_key),
  FOREIGN KEY (user_id,prep_pack_id) REFERENCES prep_packs(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,job_id) REFERENCES model_jobs(user_id,id) ON DELETE SET NULL
);
CREATE INDEX prep_sections_owner ON prep_pack_sections(user_id,prep_pack_id,status);
ALTER TABLE model_jobs DROP CONSTRAINT model_jobs_kind_check;
ALTER TABLE model_jobs ADD CONSTRAINT model_jobs_kind_check CHECK (kind IN
  ('paste','ingest','rep_extract','debrief','workspace_map','immerse_week','voice_finish','write_document','prep_section'));
