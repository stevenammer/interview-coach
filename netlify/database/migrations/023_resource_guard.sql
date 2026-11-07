-- One real database lock shared across processes, never a per-worker JS mutex.
-- Serializes short reservation changes so account/site budgets and idempotency
-- checks observe the preceding committed reservation.
CREATE TABLE resource_guard (id integer PRIMARY KEY CHECK (id=1));
INSERT INTO resource_guard(id) VALUES(1);

-- Composite owner FKs must retain user_id when their optional pointer clears.
-- The old unrestricted SET NULL tried to null user_id as well, violating NOT NULL.
DO $$ BEGIN
  IF to_regclass('coach_notes') IS NOT NULL THEN
    ALTER TABLE coach_notes DROP CONSTRAINT coach_notes_user_id_interview_id_fkey;
    ALTER TABLE coach_notes ADD CONSTRAINT coach_notes_user_id_interview_id_fkey
      FOREIGN KEY(user_id,interview_id) REFERENCES interviews(user_id,id) ON DELETE SET NULL (interview_id);
  END IF;
  IF to_regclass('prep_pack_sections') IS NOT NULL THEN
    ALTER TABLE prep_pack_sections DROP CONSTRAINT prep_pack_sections_user_id_job_id_fkey;
    ALTER TABLE prep_pack_sections ADD CONSTRAINT prep_pack_sections_user_id_job_id_fkey
      FOREIGN KEY(user_id,job_id) REFERENCES model_jobs(user_id,id) ON DELETE SET NULL (job_id);
  END IF;
END $$;
