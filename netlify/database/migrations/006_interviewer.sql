ALTER TABLE interviews ADD COLUMN difficulty integer NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 4);
ALTER TABLE interviews ADD COLUMN practice_mode text NOT NULL DEFAULT 'mock' CHECK (practice_mode IN ('mock','coach'));
