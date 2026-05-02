CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  prompt TEXT NOT NULL,
  owner_id TEXT,
  payload TEXT,
  result TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS gallery (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  size TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model TEXT,
  quality TEXT,
  output_format TEXT,
  output_compression INTEGER,
  n INTEGER,
  api_path TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  has_reference INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_public_created ON gallery(is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_owner_created ON gallery(owner_id, created_at DESC);
