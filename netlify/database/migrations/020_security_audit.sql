ALTER TABLE model_jobs ADD COLUMN input_hash text;
CREATE INDEX model_jobs_dedupe ON model_jobs(user_id,kind,input_hash,created_at);
