-- Migración 007 — El catálogo público solo muestra títulos con vídeo directo.
-- Ejecutar después de 005. Los embeds se conservan internamente para reextraerlos.

UPDATE media_items AS mi
SET has_streams = EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(mi.servers, '[]'::jsonb)) AS server
  WHERE NULLIF(server->>'direct_stream', '') IS NOT NULL
    AND COALESCE(server->>'status', 'online') <> 'offline'
) OR EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(mi.seasons, '[]'::jsonb)) AS season,
       jsonb_array_elements(COALESCE(season->'episodes', '[]'::jsonb)) AS episode,
       jsonb_array_elements(COALESCE(episode->'servers', '[]'::jsonb)) AS server
  WHERE NULLIF(server->>'direct_stream', '') IS NOT NULL
    AND COALESCE(server->>'status', 'online') <> 'offline'
);

DROP INDEX IF EXISTS idx_media_playable;
CREATE INDEX IF NOT EXISTS idx_media_playable
  ON media_items (updated_at DESC)
  WHERE has_streams = true;

-- La búsqueda paginada debe usar exactamente la misma regla, incluidos sus totales.
CREATE OR REPLACE FUNCTION search_media(q text, lim int, off int)
RETURNS TABLE (item media_items, total bigint)
LANGUAGE sql STABLE AS $$
  SELECT mi,
         count(*) OVER() AS total
  FROM media_items mi
  WHERE mi.title_normalized LIKE '%' || q || '%'
    AND mi.has_streams = true
  ORDER BY (CASE WHEN mi.title_normalized LIKE q || '%' THEN 0 ELSE 1 END),
           mi.rating DESC NULLS LAST,
           mi.title_normalized
  LIMIT lim OFFSET off;
$$;

GRANT EXECUTE ON FUNCTION search_media(text, int, int) TO anon;
