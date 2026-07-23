-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 005 — Unificación multifuente + disponibilidad real de enlaces.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 004.
--
-- Resuelve dos defectos observables en la API:
--
-- 1. CONTENIDO DUPLICADO ENTRE FUENTES.
--    La misma película existe en TioPlus y en FuegoCine con slugs distintos. Como
--    `tmdb_id` es UNIQUE, la segunda copia no podía insertarse y el crawl la fusionaba
--    con la existente… descartando su `source_url`. Resultado: una sola ficha que solo
--    sabía resolver enlaces de UNA de las dos fuentes, y los servidores de la otra se
--    perdían. `source_urls` guarda TODAS las páginas de origen de la misma entidad, de
--    modo que los servidores se unifican bajo el registro oficial de TMDB.
--
-- 2. FICHAS FANTASMA (sin ningún enlace reproducible).
--    El catálogo se puebla con metadata de TMDB antes de saber si la fuente tiene
--    enlaces, así que aparecen tarjetas en el home y en la búsqueda que nunca podrán
--    reproducirse. `has_streams` guarda el VEREDICTO de una comprobación a fondo:
--       TRUE  → se le conocen enlaces.
--       FALSE → se comprobó y no tiene ninguno (fantasma) ⇒ se oculta de los feeds.
--       NULL  → nunca se ha comprobado ⇒ se sigue mostrando (no se oculta a ciegas).
--    La distinción es deliberada: hoy la inmensa mayoría del catálogo está sin
--    comprobar, y ocultar lo no verificado vaciaría la API.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE media_items
  -- Todas las URLs de detalle de la ficha, una por fuente (ver punto 1).
  ADD COLUMN IF NOT EXISTS source_urls TEXT[] DEFAULT '{}',
  -- Veredicto de disponibilidad. NULL = sin comprobar (ver punto 2).
  ADD COLUMN IF NOT EXISTS has_streams BOOLEAN,
  -- Cuándo se comprobó por última vez, haya dado enlaces o no.
  ADD COLUMN IF NOT EXISTS streams_checked_at TIMESTAMP WITH TIME ZONE;

-- Backfill: la URL única que ya existía pasa a ser el primer elemento del array,
-- para que ninguna ficha pierda la fuente que ya tenía.
UPDATE media_items
   SET source_urls = ARRAY[source_url]
 WHERE source_url IS NOT NULL
   AND (source_urls IS NULL OR cardinality(source_urls) = 0);

-- Feeds (home, discover, búsqueda): recorren solo lo que NO se ha descartado.
-- El índice parcial deja fuera justo las filas fantasma, que son las que no se listan.
CREATE INDEX IF NOT EXISTS idx_media_playable
  ON media_items (updated_at DESC)
  WHERE has_streams IS DISTINCT FROM false;

CREATE INDEX IF NOT EXISTS idx_media_streams_checked
  ON media_items (streams_checked_at DESC NULLS FIRST);

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC de búsqueda: misma semántica que 002 + exclusión de fichas fantasma.
-- `IS DISTINCT FROM false` mantiene visibles tanto las verificadas con enlaces (TRUE)
-- como las que nunca se han comprobado (NULL), y solo esconde las verificadas vacías.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION search_media(q text, lim int, off int)
RETURNS TABLE (item media_items, total bigint)
LANGUAGE sql STABLE AS $$
  SELECT mi,
         count(*) OVER() AS total
  FROM media_items mi
  WHERE mi.title_normalized LIKE '%' || q || '%'
    AND mi.has_streams IS DISTINCT FROM false
  ORDER BY (CASE WHEN mi.title_normalized LIKE q || '%' THEN 0 ELSE 1 END),
           mi.rating DESC NULLS LAST,
           mi.title_normalized
  LIMIT lim OFFSET off;
$$;

GRANT EXECUTE ON FUNCTION search_media(text, int, int) TO anon;

-- Consultas de control (opcionales):
--   SELECT has_streams, count(*) FROM media_items GROUP BY 1;
--   SELECT count(*) FROM media_items WHERE cardinality(source_urls) > 1;  -- fichas multifuente
--   SELECT id, title FROM media_items WHERE has_streams = false LIMIT 20; -- fantasmas detectados
