-- Migración 008 — Telemetría de reproducción.
--
-- Hasta ahora la única señal de que algo iba mal era alguien diciendo «se queda pegado». La app
-- ya mandaba un aviso al agotar las fuentes, pero contra un endpoint que devolvía 404, así que
-- no llegaba nada. Esta tabla es donde aterriza.
--
-- Sin claves foráneas a propósito: un aviso de reproducción no debe poder fallar porque la ficha
-- se borrara entre medias, y perder telemetría es peor que guardar un id huérfano.

CREATE TABLE IF NOT EXISTS playback_events (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),

  item_id      text,
  episode_id   text,
  server_host  text,
  delivery_mode text,

  -- 'ok' | 'failed' | 'playback_failed:<n>' …
  outcome      text NOT NULL DEFAULT 'unknown',

  -- Milisegundos hasta el primer fotograma. Es el número que persigue todo el trabajo de
  -- arranque: sin medirlo, «va más rápido» es una impresión.
  ttff_ms      integer,

  -- Cuántas veces se quedó cargando a mitad y cuánto tiempo en total.
  stalls       integer,
  stalled_ms   integer,

  -- Cuántas veces hubo que cambiar de servidor. Dice qué hosts fallan de verdad.
  failovers    integer,

  -- Altura media reproducida. Dice si «la mejor calidad» está llegando al espectador.
  avg_height   integer,

  app_version  text
);

-- Las consultas útiles son siempre «lo último» y «por host».
CREATE INDEX IF NOT EXISTS idx_playback_recent ON playback_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_host ON playback_events (server_host, created_at DESC);

-- Solo escribe el backend con la service-role key; nadie lee desde el cliente.
ALTER TABLE playback_events ENABLE ROW LEVEL SECURITY;
