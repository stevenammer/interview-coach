ALTER TABLE workspaces ADD COLUMN hunt_status text NOT NULL DEFAULT 'saved'
  CHECK (hunt_status IN ('saved','applied','interviewing','offer','accepted','rejected','withdrawn','no_response'));
ALTER TABLE workspaces ADD COLUMN applied_on date;
ALTER TABLE workspaces ADD COLUMN next_step text;
ALTER TABLE workspaces ADD COLUMN next_step_on date;
ALTER TABLE workspaces ADD COLUMN hunt_notes text;
ALTER TABLE workspaces ADD COLUMN posting_link text;

CREATE TABLE job_hunt_history (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  action text NOT NULL,
  note text,
  happened_on date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE
);
CREATE INDEX job_hunt_history_owner_workspace ON job_hunt_history(user_id,workspace_id,created_at DESC);
