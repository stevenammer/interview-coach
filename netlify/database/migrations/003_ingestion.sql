ALTER TABLE sources DROP CONSTRAINT sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK
  (kind IN ('resume','jd','user_assertion','transcript','linkedin','background','writing_sample'));
ALTER TABLE sources ADD COLUMN parser_version integer NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN extraction_status text NOT NULL DEFAULT 'ready';
ALTER TABLE sources ADD COLUMN original_name text;
ALTER TABLE sources ADD COLUMN mime_type text;
ALTER TABLE sources ADD COLUMN blob_prefix text;
ALTER TABLE sources ADD COLUMN page_offsets_json jsonb NOT NULL DEFAULT '[]';
ALTER TABLE source_spans ADD COLUMN page_number integer;
ALTER TABLE source_spans ADD COLUMN section_label text;
CREATE TABLE uploads (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL, chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 8),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10000000),
  mime_type text NOT NULL, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
  FOREIGN KEY (user_id,source_id) REFERENCES sources(user_id,id) ON DELETE CASCADE
);
CREATE TABLE upload_chunks (
  upload_id uuid NOT NULL, user_id uuid NOT NULL, part integer NOT NULL,
  byte_size integer NOT NULL, PRIMARY KEY(upload_id,part),
  FOREIGN KEY (user_id,upload_id) REFERENCES uploads(user_id,id) ON DELETE CASCADE
);
CREATE TABLE writing_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
