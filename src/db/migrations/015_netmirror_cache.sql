-- Migración 015 — Qué obras tiene NetMirror, contestada una vez y no en cada apertura.
--
-- La API por tmdb_id de NetMirror (`net27.cc/api/embed-tmdb/{id}`) contesta rápido cuando SÍ
-- tiene el título y con `noSource:true` cuando no. Preguntar cada apertura por las que sabemos
-- que no tiene gasta petición y —lo peor— dispara el rate-limit de la API: cuando el catálogo
-- consulta muchas fichas seguidas (portada, listados), la API empieza a decir `noSource` a las
-- que sí tiene, y la cobertura medida CAE (el 100% de 10 series pasa al 0% en 100 paralelas).
--
-- Esta tabla guarda por tmdb_id (+ s/e para episodios) si NetMirror tiene la obra. Un barrido
-- offline la rellena una vez y las aperturas leen de aquí antes de decidir si preguntar. Las
-- URLs mp4 NO se guardan aquí: caducan en horas y se re-resuelven al servir.
--
-- Movies: (tmdb_id, 0, 0). Episodes: (tmdb_id_serie, s, e). Un mismo tmdb no colisiona porque
-- las pelis usan (X, 0, 0) y las series (X, ≥1, ≥1).

CREATE TABLE IF NOT EXISTS netmirror_cache (
  tmdb_id       int  NOT NULL,
  temporada     int  NOT NULL DEFAULT 0,
  episodio      int  NOT NULL DEFAULT 0,
  -- true si la API devolvió `mode:"proxy"` con mp4; false si `noSource:true`.
  disponible    bool NOT NULL,
  -- Mejor resolución vista en `streams` (o `mp4` default) cuando disponible.
  resolucion    int,
  -- Cuándo se comprobó. El planificador decide cuándo revisitar los `false`.
  comprobado_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tmdb_id, temporada, episodio)
);

-- Índice para el barrido: ver qué fichas llevan mucho sin repasarse.
CREATE INDEX IF NOT EXISTS idx_netmirror_cache_comprobado
  ON netmirror_cache (comprobado_at);

-- Índice para lookup por tmdb (todas las s/e de una serie).
CREATE INDEX IF NOT EXISTS idx_netmirror_cache_tmdb
  ON netmirror_cache (tmdb_id);
