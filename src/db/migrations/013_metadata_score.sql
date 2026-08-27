-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 013 — Cuánta ficha tiene cada ficha, para que la que no tiene baje.
-- Ejecutar UNA VEZ (o `npm run migrar -- --apply`), DESPUÉS de 012.
--
-- El complemento (012 + completarHuecos) tapa lo que puede, pero hay huecos que
-- no los llena nadie: agotadas TMDB, Wikidata, Wikipedia y Fanart, 151 de 895
-- fichas siguen sin logo y otras tantas sin tráiler ni clasificación. Son cine
-- latinoamericano viejo del que nunca se publicó ese material.
--
-- Esas fichas no sobran —se reproducen igual de bien— pero anunciarlas al mismo
-- nivel que una ficha completa sí es un problema: en la portada se ven como un
-- hueco gris entre carátulas, y en la búsqueda se cuelan por delante de un
-- título que el espectador reconocería. La respuesta no es esconderlas, es
-- ordenarlas: cuanto menos tenga una ficha, más abajo aparece.
--
-- POR QUÉ UNA COLUMNA GENERADA Y NO UN CAMPO QUE ALGUIEN ACTUALICE.
--
-- Lo calcula Postgres a partir de la propia fila, en cada escritura, sin que
-- ningún camino de código pueda olvidarse. Y hay cuatro caminos que escriben
-- fichas (el crawl, el barrido de relleno, las reparaciones y el panel manual):
-- con un campo mantenido a mano, el primero que no se acordara dejaría fichas
-- con una puntuación mentirosa, que es peor que no tener puntuación.
--
-- LOS PESOS son cuánto se nota la ausencia MIRANDO la app, no cuántos campos
-- hay. Sin carátula la ficha es un rectángulo vacío en el carrusel; sin
-- clasificación por edades no lo nota nadie. Suman 100.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS metadata_score SMALLINT
  GENERATED ALWAYS AS (
      -- Lo que se ve en el carrusel antes de pulsar nada.
      (CASE WHEN poster        IS NOT NULL AND poster        <> '' THEN 22 ELSE 0 END)
    + (CASE WHEN overview      IS NOT NULL AND overview      <> '' THEN 18 ELSE 0 END)
    + (CASE WHEN backdrop      IS NOT NULL AND backdrop      <> '' THEN 14 ELSE 0 END)
    + (CASE WHEN logo          IS NOT NULL AND logo          <> '' THEN 10 ELSE 0 END)
      -- Lo que decide si merece la pena abrirla.
    + (CASE WHEN rating > 0                                        THEN  8 ELSE 0 END)
    + (CASE WHEN COALESCE(array_length(genres, 1), 0) > 0          THEN  8 ELSE 0 END)
    + (CASE WHEN jsonb_typeof(cast_data) = 'array'
             AND jsonb_array_length(cast_data) > 0                 THEN  6 ELSE 0 END)
    + (CASE WHEN runtime > 0                                       THEN  6 ELSE 0 END)
      -- Detalles: se agradecen y no se echan de menos.
    + (CASE WHEN content_rating IS NOT NULL AND content_rating <> '' THEN 4 ELSE 0 END)
    + (CASE WHEN trailer        IS NOT NULL AND trailer        <> '' THEN 4 ELSE 0 END)
  ) STORED;

-- Ordenar por esto es la operación más frecuente que va a tener la tabla: entra
-- en el ORDER BY del home, del "ver todo" y de la búsqueda.
CREATE INDEX IF NOT EXISTS idx_media_metadata_score ON media_items (metadata_score DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- La búsqueda, con la puntuación metida en el orden.
--
-- Va DESPUÉS del rango de prefijo y ANTES de la nota, y ese sitio es la
-- decisión de verdad: quien escribe "matilda" quiere Matilda, y la puntuación
-- no puede tapar un acierto de nombre (por eso no va primero). Pero entre dos
-- resultados que encajan igual de bien, manda el que el espectador va a poder
-- mirar (por eso va antes que `rating`, donde una ficha pelada con nota alta
-- ganaba a una completa).
--
-- Como casi todas las fichas completas puntúan lo mismo, esto NO reordena el
-- catálogo bueno: agrupa arriba lo que está entero y hunde lo que está a
-- medias, conservando dentro de cada grupo el orden por nota de siempre.
--
-- OJO: se reescribe entera y conserva `has_streams = true`, que se añadió en
-- caliente y NO está en la migración 002. Sin esa línea, la búsqueda volvería a
-- resucitar los títulos que el verificador ya descartó por no reproducirse.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION search_media(q text, lim int, off int)
RETURNS TABLE (item media_items, total bigint)
LANGUAGE sql STABLE AS $$
  SELECT mi,
         count(*) OVER() AS total
  FROM media_items mi
  WHERE mi.title_normalized LIKE '%' || q || '%'
    AND mi.has_streams = true
  ORDER BY (CASE WHEN mi.title_normalized LIKE q || '%' THEN 0 ELSE 1 END),
           mi.metadata_score DESC NULLS LAST,
           mi.rating DESC NULLS LAST,
           mi.title_normalized
  LIMIT lim OFFSET off;
$$;

GRANT EXECUTE ON FUNCTION search_media(text, int, int) TO anon;

-- Consultas de control (opcionales):
--   -- Reparto de la puntuación:
--   SELECT width_bucket(metadata_score, 0, 101, 5) AS tramo,
--          min(metadata_score), max(metadata_score), count(*)
--     FROM media_items GROUP BY 1 ORDER BY 1;
--
--   -- Las peores fichas del catálogo, que son las que esto manda al final:
--   SELECT title, metadata_score, logo IS NULL AS sin_logo, trailer IS NULL AS sin_trailer
--     FROM media_items ORDER BY metadata_score ASC LIMIT 20;
