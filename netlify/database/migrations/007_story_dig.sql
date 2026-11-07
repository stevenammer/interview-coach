CREATE TABLE story_digs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL,
  competency text NOT NULL, scene_text text, reflection text,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','awaiting_confirmation','confirmed')),
  created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
  UNIQUE(user_id,id),
  FOREIGN KEY (user_id,workspace_id) REFERENCES workspaces(user_id,id) ON DELETE CASCADE
);
CREATE INDEX story_digs_owner ON story_digs(user_id,workspace_id);
