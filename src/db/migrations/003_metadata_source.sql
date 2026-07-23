-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 003 — Cobertura de metadata al 100%.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 002.
--
-- 1. Marca de origen de la metadata: 'tmdb' (match verificado contra TMDB) o
--    'source' (último recurso: póster/sinopsis del sitio de donde se extrajo).
-- 2. Los títulos sin match en TMDB se guardan con un tmdb_id SINTÉTICO NEGATIVO
--    (determinista por slug). Al ser negativo nunca colisiona con un id real de
--    TMDB, así que el UNIQUE de tmdb_id deja de producir choques/duplicados.
--    El CHECK antiguo (si lo hubiera) no aplica; INT admite negativos sin cambios.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS metadata_source VARCHAR(10) DEFAULT 'tmdb';

-- Auditoría rápida de cobertura: cuántas fichas viven del fallback de la fuente.
CREATE INDEX IF NOT EXISTS idx_media_metadata_source ON media_items (metadata_source);

-- Consulta de control (opcional):
--   SELECT metadata_source, count(*) FROM media_items GROUP BY 1;
--   SELECT count(*) FROM media_items WHERE poster IS NULL;   -- debe ser 0
