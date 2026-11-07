ALTER TABLE model_jobs DROP CONSTRAINT model_jobs_kind_check;
ALTER TABLE model_jobs ADD CONSTRAINT model_jobs_kind_check CHECK (kind IN
  ('paste','ingest','rep_extract','debrief','workspace_map','immerse_week','voice_finish','write_document'));
