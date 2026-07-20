ALTER TABLE gallery ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gallery ADD COLUMN byte_size INTEGER;
CREATE INDEX IF NOT EXISTS idx_gallery_favorite_created ON gallery(favorite, created_at DESC);
