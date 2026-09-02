-- Migración 016 — Multi-audio real desde NetMirror.
--
-- La API `/api/embed-tmdb/{tmdb}` de NetMirror devuelve UN mp4 con UNA sola pista de audio.
-- Pero el ENDPOINT INTERNO `/hls/{netflix_id}.m3u8?in=<token>` sí trae master multi-audio con
-- `#EXT-X-MEDIA TYPE=AUDIO LANGUAGE=... NAME=...`. Comprobado: Taskaree 7 pistas, Oppenheimer 8,
-- algunas fichas con DOS pistas `spa` (Latino + Castellano).
--
-- NetMirror trabaja por NETFLIX IDs, no tmdb. `GET /search.php?s=<titulo>` devuelve el netflix
-- id sin cookies ni token, así que se puede resolver offline y guardarlo aquí. Los idiomas
-- vienen del master, que sí requiere token de sesión — se pobla cuando el usuario tenga sesión
-- viva o desde el propio cliente Android al reproducir.

ALTER TABLE netmirror_cache
  ADD COLUMN IF NOT EXISTS netflix_id text,
  -- Array de {lang, name_es, default}. Se rellena al ver un master con éxito; null hasta entonces.
  ADD COLUMN IF NOT EXISTS idiomas_audio jsonb,
  -- Dominio activo de reproducción (net52.cc, netXX.cc). Rota cada mes.
  ADD COLUMN IF NOT EXISTS dominio_hls text;

-- Índice para lookup rápido por netflix_id (auditoría y depuración).
CREATE INDEX IF NOT EXISTS idx_netmirror_cache_netflix
  ON netmirror_cache (netflix_id) WHERE netflix_id IS NOT NULL;
