-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 006 — El id de TMDB es único POR CATÁLOGO, no en global.
-- Ejecutar UNA VEZ en el SQL Editor de Supabase, DESPUÉS de 005.
--
-- TMDB numera las películas y las series por SEPARADO, así que el mismo número
-- identifica dos títulos que no tienen nada que ver:
--
--     movie 108291 = "Road Dogz"  (2002)      tv 108291 = "Snowdrop"        (2021)
--     movie  74586 = "כלבת"       (2010)      tv  74586 = "¿Solo en casa?"  (2017)
--
-- La tabla declaraba `tmdb_id INT UNIQUE`, un UNIQUE que abarca los dos catálogos
-- a la vez. Consecuencia: en cuanto una película ocupaba un número, la serie con
-- ese mismo número NO PODÍA guardarse bien, por muy correcto que fuera su match.
-- No era un empate a resolver, era una ficha condenada a estar mal.
--
-- La clave real de una ficha de TMDB es el par (id, catálogo), y eso es lo que
-- pasa a exigir la restricción. Sigue impidiendo lo que tenía que impedir —dos
-- filas para la MISMA película— sin bloquear lo que nunca debió bloquear.
--
-- No hace falta limpiar nada antes: si `tmdb_id` era único en global, el par
-- (tmdb_id, type) lo es por definición, así que la restricción nueva entra sin
-- conflictos sobre los datos que ya están.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Retirar el UNIQUE que solo miraba `tmdb_id`. El nombre lo pone PostgreSQL al
--    crear la tabla (`media_items_tmdb_id_key`), pero no se da por supuesto: se
--    busca cualquier restricción única cuya ÚNICA columna sea tmdb_id.
DO $$
DECLARE con_name text;
BEGIN
  FOR con_name IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relname = 'media_items'
       AND n.nspname = 'public'
       AND c.contype = 'u'
       AND c.conkey = ARRAY[(SELECT a.attnum
                               FROM pg_attribute a
                              WHERE a.attrelid = c.conrelid
                                AND a.attname = 'tmdb_id')]
  LOOP
    EXECUTE format('ALTER TABLE public.media_items DROP CONSTRAINT %I', con_name);
    RAISE NOTICE 'Retirada la restricción global %', con_name;
  END LOOP;
END $$;

-- Por si en algún momento se creó como índice único suelto en vez de restricción.
DROP INDEX IF EXISTS public.media_items_tmdb_id_key;
DROP INDEX IF EXISTS public.idx_media_tmdb_id_unique;

-- 2) La restricción correcta: única por (id de TMDB, catálogo).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'media_items' AND c.conname = 'media_items_tmdb_id_type_key'
  ) THEN
    ALTER TABLE public.media_items
      ADD CONSTRAINT media_items_tmdb_id_type_key UNIQUE (tmdb_id, type);
  END IF;
END $$;

-- 3) Las búsquedas por tmdb_id siguen siendo frecuentes (resolución por id numérico
--    en catalogService) y ya no las cubre un índice de una sola columna.
CREATE INDEX IF NOT EXISTS idx_media_tmdb_id ON public.media_items (tmdb_id);

-- Consultas de control (opcionales):
--   -- Fichas que comparten número entre catálogos: antes eran imposibles, ahora conviven.
--   SELECT tmdb_id, count(*), array_agg(type), array_agg(title)
--     FROM media_items GROUP BY tmdb_id HAVING count(*) > 1;
--
--   -- Debe devolver la restricción nueva y ninguna sobre tmdb_id a secas:
--   SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
--    WHERE t.relname = 'media_items' AND c.contype = 'u';
