-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 004 — Servidores persistidos + metadata rica para el Home.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 003.
--
-- Motivación (rendimiento del popup de detalle):
--   Hasta ahora los servidores NO se guardaban, así que abrir una ficha obligaba a
--   scrapear en vivo (búsqueda por título + hasta 4 detalles). Con `servers`,
--   `seasons` y sobre todo `source_url` persistidos, /api/v1/media/:id responde
--   metadata desde Postgres en milisegundos y la resolución de enlaces se hace
--   aparte (/api/v1/media/:id/streams) reutilizando la URL exacta de la fuente.
--
-- Motivación (Home estilo Netflix):
--   `runtime` y `director` completan la ficha del hero; los índices por
--   (type, rating) y por géneros permiten armar los carruseles temáticos y el
--   discover paginado directamente en la base de datos.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS servers JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS seasons JSONB DEFAULT '[]'::jsonb,
  -- URL exacta del detalle en la fuente (tioplus/fuegocine). Con ella basta UN
  -- scrapeDetail para resolver enlaces, en lugar de una búsqueda por título.
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS runtime INT,
  ADD COLUMN IF NOT EXISTS director TEXT,
  -- Frescura de los enlaces: por debajo de 24 h se sirven directo de la DB.
  ADD COLUMN IF NOT EXISTS streams_updated_at TIMESTAMP WITH TIME ZONE;

-- Carruseles del home y discover paginado: filtro por tipo ordenado por nota.
CREATE INDEX IF NOT EXISTS idx_media_type_rating ON media_items (type, rating DESC NULLS LAST);

-- Filas por género (genres @> '{Acción}') en milisegundos.
CREATE INDEX IF NOT EXISTS idx_media_genres ON media_items USING gin (genres);

-- Selección de títulos con enlaces ya resueltos (pre-calentado del job).
CREATE INDEX IF NOT EXISTS idx_media_streams_updated ON media_items (streams_updated_at DESC NULLS LAST);

-- Consultas de control (opcionales):
--   SELECT count(*) FROM media_items WHERE source_url IS NOT NULL;
--   SELECT count(*) FROM media_items WHERE jsonb_array_length(servers) > 0;
