-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 001 — Búsqueda por prefijo instantánea (Fase 4.3 del plan)
-- Ejecutar UNA VEZ en el SQL Editor de Supabase.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Columna de título normalizado (minúsculas, sin acentos).
--    La mantiene scripts/refreshCatalog.ts en cada refresh.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS title_normalized TEXT;

-- 2. Backfill best-effort para filas existentes
--    (el próximo refresh la reescribe con la normalización completa sin acentos).
UPDATE media_items SET title_normalized = lower(title) WHERE title_normalized IS NULL;

-- 3. Índice de prefijo: hace que ilike 'q%' responda en milisegundos.
CREATE INDEX IF NOT EXISTS idx_media_title_norm_prefix
  ON media_items (title_normalized text_pattern_ops);

-- 4. Índice para el orden por frescura del getAll DB-first.
CREATE INDEX IF NOT EXISTS idx_media_updated_at
  ON media_items (updated_at DESC);

-- 5. Limpieza: la tabla video_servers nunca fue usada por el código.
DROP TABLE IF EXISTS video_servers;

-- 6. Acceso a datos para el modo DB-first:
--    - La API (anon key) solo necesita LEER media_items.
--    - El job de refresh escribe con la SUPABASE_SERVICE_ROLE_KEY (env/secret del
--      workflow), que salta RLS — nunca la pongas en el código ni en el cliente.
--    Nota: hoy la tabla tiene RLS ACTIVADO en la instancia real (las escrituras anon
--    fallan), aunque el schema.sql original declaraba lo contrario.
ALTER TABLE media_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read media_items" ON media_items;
CREATE POLICY "public read media_items" ON media_items FOR SELECT USING (true);
