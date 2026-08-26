-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 012 — De dónde salió CADA campo, no de dónde salió la ficha.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 011.
--
-- `metadata_source` (migración 003) es UNA marca para toda la fila: 'tmdb' o
-- 'source'. Servía cuando solo había dos orígenes y competían por la ficha
-- entera. Ya no es el caso: medido sobre las 609 fichas del catálogo, al 23,5 %
-- le falta el logo, al 21,8 % el tráiler y al 20 % la clasificación por edades,
-- y volviendo a preguntarle a TMDB campo por campo resulta que el 92 % de esos
-- huecos son huecos DE TMDB — cine argentino y venezolano viejo con ficha
-- creada pero vacía. Eso solo lo tapa una cascada de fuentes distintas, y
-- entonces una ficha pasa a tener la sinopsis de Wikipedia, la duración de
-- Wikidata y todo lo demás de TMDB a la vez.
--
-- Con una marca por fila eso es indistinguible, y la consecuencia práctica es
-- que no se puede volver atrás: el día que TMDB publique la sinopsis en español
-- que hoy no tiene, no hay forma de saber cuál de sus campos era prestado y
-- cuál suyo, así que o se pisa lo bueno o se conserva lo peor para siempre.
--
--     {"overview": "wikipedia-es:https://es.wikipedia.org/wiki/Sotto_voce",
--      "runtime":  "wikidata:Q6047450",
--      "logo":     "fanart"}
--
-- Los campos que NO aparecen en el objeto vienen de TMDB, que es el caso normal
-- y no hace falta anotarlo 609 veces. `metadata_source` se queda como está: aún
-- distingue la ficha entera rescatada de la web de origen.
--
-- Y guardar la URL del artículo no es decorativo: Wikipedia es CC BY-SA y el
-- texto que se publique en la app pide atribución. Sin esta columna no habría
-- de dónde sacarla.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS metadata_fuentes JSONB DEFAULT '{}'::jsonb;

-- Cuántas fichas viven de un complemento, y de cuál. El índice GIN permite
-- preguntar por campo ("¿qué fichas tienen la sinopsis prestada?") sin recorrer
-- la tabla entera, que es la consulta con la que se decide cuándo reintentar
-- TMDB para recuperar el dato propio.
CREATE INDEX IF NOT EXISTS idx_media_metadata_fuentes ON media_items USING gin (metadata_fuentes);

-- Consultas de control (opcionales):
--   -- Reparto de complementos por campo:
--   SELECT k AS campo, split_part(v, ':', 1) AS fuente, count(*)
--     FROM media_items, jsonb_each_text(metadata_fuentes) AS e(k, v)
--    GROUP BY 1, 2 ORDER BY 3 DESC;
--
--   -- Fichas con la sinopsis prestada (candidatas a recuperar cuando TMDB se ponga al día):
--   SELECT id, title, metadata_fuentes->>'overview'
--     FROM media_items WHERE metadata_fuentes ? 'overview';
