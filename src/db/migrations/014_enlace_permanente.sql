-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 014 — Distinguir el enlace que CADUCA del que solo puede morirse.
-- Ejecutar con `npm run migrar -- --apply`, DESPUÉS de la 013.
--
-- POR QUÉ, con el apagón que lo motivó:
--
-- `soloPublicables` exige que la prueba de reproducción tenga menos de 6 horas.
-- El 27/08/2026 el verificador se cayó (fallo de compilación en CI) y el
-- catálogo se apagó SOLO: de 1.114 fichas que pasaban todos los demás filtros,
-- quedó 1. La app dejó de cargar.
--
-- Y al mirar por qué, salió que la regla se estaba aplicando a un montón de
-- títulos que no la necesitan. Medido ese día sobre 1.748 servidores con vídeo:
--
--     public     1055     la URL no caduca ni va atada a una IP
--     redirect    544     el CDN la firma con caducidad
--     proxy       149     idem, y además valida la IP que la acuñó
--
-- 812 de las 1.120 fichas publicables tienen al menos un enlace `public`. Sus
-- URLs seguían vivas mientras el catálogo las escondía por «sello viejo».
--
-- PERO PERMANENTE NO ES ETERNO, y esa es la parte que no se puede simplificar:
-- `public` significa que la URL no caduca POR FIRMA, no que el fichero vaya a
-- estar ahí siempre. archive.org retira material y un CDN puede devolver 404.
-- Así que estos enlaces no quedan exentos de comprobación: se les da una
-- ventana larga (ver VERIFICADO_PERMANENTE_MS en streamSorter) en lugar de la
-- de seis horas, que está calculada para la caducidad de una firma y no para
-- que a alguien le den de baja una película.
--
-- La columna es GENERADA por la misma razón que `metadata_score`: hay cuatro
-- caminos que escriben fichas y el primero que se olvidara de recalcularla
-- dejaría títulos anunciados por una permanencia que ya no tienen.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS enlace_permanente BOOLEAN
  GENERATED ALWAYS AS (
    -- Películas: los servidores cuelgan de la ficha.
    jsonb_path_exists(
      COALESCE(servers, '[]'::jsonb),
      '$[*] ? (@.direct_mode == "public" && exists(@.direct_stream))'
    )
    -- Series: cuelgan de cada capítulo. Sin esta mitad, una serie entera servida
    -- desde archive.org contaría como caducable y se apagaría con el resto.
    OR jsonb_path_exists(
      COALESCE(seasons, '[]'::jsonb),
      '$[*].episodes[*].servers[*] ? (@.direct_mode == "public" && exists(@.direct_stream))'
    )
  ) STORED;

-- Entra en el WHERE de todos los listados, junto a has_streams.
CREATE INDEX IF NOT EXISTS idx_media_enlace_permanente
  ON media_items (enlace_permanente) WHERE enlace_permanente;

-- Consultas de control (opcionales):
--   SELECT enlace_permanente, count(*) FROM media_items
--    WHERE has_streams GROUP BY 1;
--
--   -- Las que dependen de una firma que caduca: son las únicas que de verdad
--   -- necesitan el sello de 6 h.
--   SELECT count(*) FROM media_items
--    WHERE has_streams AND NOT enlace_permanente;
