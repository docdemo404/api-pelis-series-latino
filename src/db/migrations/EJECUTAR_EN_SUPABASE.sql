-- ═══════════════════════════════════════════════════════════════════════════════
--  PENDIENTE DE EJECUTAR — pega TODO este archivo en el SQL Editor de Supabase
--  y pulsa "Run". Es seguro: todo usa IF NOT EXISTS, así que puedes ejecutarlo
--  las veces que quieras sin romper nada ni perder datos.
--
--  Reúne las dos migraciones que la base de datos en producción todavía no tiene:
--    · 003_metadata_source.sql          (auditoría del origen de la metadata)
--    · 004_streams_and_rich_metadata.sql (enlaces persistidos + ficha completa)
--
--  Qué desbloquea:
--    · source_url  → abrir una ficha y darle a Reproducir pasa de ~3 s a ~0,1 s
--    · servers/seasons → los enlaces se guardan y se reutilizan entre visitas
--    · runtime, director, logo → el hero del inicio deja de salir incompleto
--    · índices por tipo/género → carruseles y "ver todo" resueltos en Postgres
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Migración 003 — Origen de la metadata ──────────────────────────────────────
-- 'tmdb' = ficha verificada contra TMDB · 'source' = metadata del sitio scrapeado.
ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS metadata_source VARCHAR(10) DEFAULT 'tmdb';

CREATE INDEX IF NOT EXISTS idx_media_metadata_source ON media_items (metadata_source);

-- ── Migración 004 — Enlaces persistidos + metadata rica ────────────────────────
ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS servers JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS seasons JSONB DEFAULT '[]'::jsonb,
  -- URL exacta del detalle en la fuente: con ella basta UNA petición para resolver
  -- los enlaces, en lugar de una búsqueda por título contra las dos fuentes.
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS runtime INT,
  ADD COLUMN IF NOT EXISTS director TEXT,
  -- Frescura de los enlaces: por debajo de 24 h se sirven directos de la base de datos.
  ADD COLUMN IF NOT EXISTS streams_updated_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_media_type_rating ON media_items (type, rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_media_genres ON media_items USING gin (genres);
CREATE INDEX IF NOT EXISTS idx_media_streams_updated ON media_items (streams_updated_at DESC NULLS LAST);

-- ── Comprobación (opcional) ────────────────────────────────────────────────────
-- Debe devolver 8 filas: metadata_source, servers, seasons, source_url, runtime,
-- director, streams_updated_at (y ninguna más de las nuevas).
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'media_items'
  AND column_name IN ('metadata_source','servers','seasons','source_url','runtime','director','streams_updated_at')
ORDER BY column_name;
