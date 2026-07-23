-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 002 — Búsqueda por SUBSTRING sobre el catálogo completo + total exacto.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 001.
--
-- Habilita:
--   • Recuperación TOTAL: "ma" encuentra "Matilda" (substring, no solo prefijo).
--   • Scroll infinito: total_results real vía count(*) OVER() y paginación LIMIT/OFFSET.
--   • Ranking prefijo-primero (misma semántica que scoreAndSortResults).
-- Requiere el catálogo poblado por scripts/refreshCatalog.ts (crawl completo).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Extensión de trigramas para acelerar ilike '%término%' a escala.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Índice GIN trigram sobre title_normalized (búsqueda por substring en milisegundos).
CREATE INDEX IF NOT EXISTS idx_media_title_norm_trgm
  ON media_items USING gin (title_normalized gin_trgm_ops);

-- 3. RPC de búsqueda rankeada y paginada con TOTAL exacto.
--    Devuelve cada fila como compuesto `item` (media_items) + `total` (conteo global
--    del match, calculado por la window ANTES del LIMIT).
--    Orden: prefijo-primero (rank 0) sobre substring (rank 1), luego rating, luego título.
CREATE OR REPLACE FUNCTION search_media(q text, lim int, off int)
RETURNS TABLE (item media_items, total bigint)
LANGUAGE sql STABLE AS $$
  SELECT mi,
         count(*) OVER() AS total
  FROM media_items mi
  WHERE mi.title_normalized LIKE '%' || q || '%'
  ORDER BY (CASE WHEN mi.title_normalized LIKE q || '%' THEN 0 ELSE 1 END),
           mi.rating DESC NULLS LAST,
           mi.title_normalized
  LIMIT lim OFFSET off;
$$;

-- 4. Permitir que el rol anónimo (la API) ejecute el RPC.
GRANT EXECUTE ON FUNCTION search_media(text, int, int) TO anon;
