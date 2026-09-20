-- Candidatos preparados en cloud y comprobados por instalaciones Android desde redes distintas.
-- El esquema de produccion real vive en `turso/esquema.sql`; esta copia documenta la migracion.
CREATE TABLE IF NOT EXISTS netmirror_trabajos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  ott TEXT NOT NULL CHECK (ott IN ('nf','pv','hs')),
  titulo TEXT NOT NULL,
  titulo_original TEXT,
  anio TEXT,
  prioridad INTEGER NOT NULL DEFAULT 0,
  ronda INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','confirmado','descartado')),
  proxima_revision TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  creado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actualizado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tmdb_id, ott)
);
CREATE TABLE IF NOT EXISTS netmirror_asignaciones (
  token TEXT PRIMARY KEY,
  trabajo_id INTEGER NOT NULL REFERENCES netmirror_trabajos(id) ON DELETE CASCADE,
  ronda INTEGER NOT NULL,
  dispositivo_hash TEXT NOT NULL,
  red_hash TEXT NOT NULL,
  expira_at TEXT NOT NULL,
  creado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (trabajo_id, ronda, dispositivo_hash)
);
CREATE TABLE IF NOT EXISTS netmirror_verificaciones (
  trabajo_id INTEGER NOT NULL REFERENCES netmirror_trabajos(id) ON DELETE CASCADE,
  ronda INTEGER NOT NULL,
  dispositivo_hash TEXT NOT NULL,
  red_hash TEXT NOT NULL,
  resultado_hash TEXT NOT NULL,
  resultado_json TEXT NOT NULL,
  recibido_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (trabajo_id, ronda, dispositivo_hash)
);
