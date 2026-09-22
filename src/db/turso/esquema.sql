-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- EL ESQUEMA ENTERO, EN SQLITE (Turso / libSQL).
--
-- Es la suma de src/db/schema.sql y de las veinte migraciones de Postgres, traducida y en un solo
-- archivo, porque aquí no hay historia que reproducir: la base nace vacía y el catálogo se vuelve
-- a sacar de las fuentes. Todo es idempotente (IF NOT EXISTS), así que `npm run db:esquema` se
-- puede repetir sin miedo, y los scripts lo aplican solos al arrancar.
--
-- LO QUE CAMBIA RESPECTO A POSTGRES, y por qué:
--
--   · `text[]` (aliases, genres, subcategories, source_urls) y `jsonb` son ambos TEXT con JSON
--     dentro. El adaptador (src/db/compat.ts) los serializa al escribir y los parsea al leer, con
--     una tabla de tipos por columna, así que el resto del código sigue viendo arrays y objetos.
--   · `boolean` es INTEGER 0/1; el adaptador devuelve true/false.
--   · `timestamptz` es TEXT ISO-8601 con Z (`2026-09-16T17:01:22.663Z`), que es lo que produce
--     `new Date().toISOString()`. Se compara como texto y ordena bien porque el formato es fijo.
--   · `metadata_score` sigue siendo una columna generada. `enlace_permanente` no puede serlo
--     (SQLite no admite subconsultas ahí), así que la mantienen dos disparadores.
--   · Las vistas usan `json_each` donde Postgres usaba `jsonb_array_elements`. No hay REGEXP:
--     el sello ISO se reconoce con GLOB.
--   · No hay RLS ni roles: el token de Turso lo puede todo. `catalog_writable` del panel se
--     decide con una escritura de prueba, no consultando permisos.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- Qué versión de este archivo tiene aplicada la base. La escribe `asegurarEsquema`.
CREATE TABLE IF NOT EXISTS esquema (
    clave TEXT PRIMARY KEY,
    valor INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_items (
    id                TEXT PRIMARY KEY,
    tmdb_id           INTEGER NOT NULL,
    imdb_id           TEXT,
    type              TEXT NOT NULL CHECK (type IN ('movie', 'tvseries')),
    title             TEXT NOT NULL,
    original_title    TEXT NOT NULL,
    title_normalized  TEXT,
    aliases           TEXT NOT NULL DEFAULT '[]',
    tagline           TEXT,
    overview          TEXT,
    rating            REAL DEFAULT 0,
    content_rating    TEXT,
    release_date      TEXT,
    genres            TEXT NOT NULL DEFAULT '[]',
    subcategories     TEXT NOT NULL DEFAULT '[]',
    poster            TEXT,
    backdrop          TEXT,
    logo              TEXT,
    trailer           TEXT,
    metadata_source   TEXT DEFAULT 'tmdb',
    metadata_fuentes  TEXT NOT NULL DEFAULT '{}',
    cast_data         TEXT NOT NULL DEFAULT '[]',
    dubbing_cast_data TEXT NOT NULL DEFAULT '[]',
    runtime           INTEGER,
    director          TEXT,
    total_seasons     INTEGER DEFAULT 0,
    total_episodes    INTEGER DEFAULT 0,
    servers           TEXT NOT NULL DEFAULT '[]',
    seasons           TEXT NOT NULL DEFAULT '[]',
    manual_servers    TEXT,
    source_url        TEXT,
    source_urls       TEXT NOT NULL DEFAULT '[]',
    streams_updated_at  TEXT,
    has_streams         INTEGER,
    streams_checked_at  TEXT,
    oculto_manual       INTEGER,
    enlace_permanente   INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- La misma cuenta que la migración 013: cuánta ficha hay, de 0 a 100.
    metadata_score    INTEGER GENERATED ALWAYS AS (
          (CASE WHEN poster         IS NOT NULL AND poster         <> '' THEN 22 ELSE 0 END)
        + (CASE WHEN overview       IS NOT NULL AND overview       <> '' THEN 18 ELSE 0 END)
        + (CASE WHEN backdrop       IS NOT NULL AND backdrop       <> '' THEN 14 ELSE 0 END)
        + (CASE WHEN logo           IS NOT NULL AND logo           <> '' THEN 10 ELSE 0 END)
        + (CASE WHEN rating > 0                                          THEN  8 ELSE 0 END)
        + (CASE WHEN json_valid(genres) AND json_array_length(genres) > 0 THEN 8 ELSE 0 END)
        + (CASE WHEN json_valid(cast_data) AND json_type(cast_data) = 'array'
                 AND json_array_length(cast_data) > 0                   THEN  6 ELSE 0 END)
        + (CASE WHEN runtime > 0                                         THEN  6 ELSE 0 END)
        + (CASE WHEN content_rating IS NOT NULL AND content_rating <> '' THEN 4 ELSE 0 END)
        + (CASE WHEN trailer        IS NOT NULL AND trailer        <> '' THEN 4 ELSE 0 END)
    ) STORED,
    CONSTRAINT media_items_tmdb_id_type_key UNIQUE (tmdb_id, type)
);

CREATE INDEX IF NOT EXISTS idx_media_type              ON media_items (type);
CREATE INDEX IF NOT EXISTS idx_media_tmdb_id           ON media_items (tmdb_id);
CREATE INDEX IF NOT EXISTS idx_media_title_norm        ON media_items (title_normalized);
CREATE INDEX IF NOT EXISTS idx_media_updated_at        ON media_items (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_type_rating       ON media_items (type, rating DESC);
CREATE INDEX IF NOT EXISTS idx_media_streams_updated   ON media_items (streams_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_playable          ON media_items (updated_at DESC) WHERE has_streams = 1;
CREATE INDEX IF NOT EXISTS idx_media_streams_checked   ON media_items (streams_checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_metadata_score    ON media_items (metadata_score DESC);
CREATE INDEX IF NOT EXISTS idx_media_enlace_permanente ON media_items (enlace_permanente) WHERE enlace_permanente = 1;
CREATE INDEX IF NOT EXISTS idx_media_oculto_manual     ON media_items (oculto_manual) WHERE oculto_manual = 1;
CREATE INDEX IF NOT EXISTS idx_media_manual_servers    ON media_items (id) WHERE manual_servers IS NOT NULL;

-- `enlace_permanente` (migración 014): ¿hay algún servidor —de la ficha o de un capítulo— con
-- `direct_mode = "public"` y `direct_stream`? En Postgres era una columna generada con
-- jsonb_path_exists; aquí lo recalculan estos dos disparadores cada vez que cambian `servers` o
-- `seasons`. Recorre con json_tree: `fullkey` de un servidor de capítulo acaba en
-- `.episodes[N].servers[M]`, y el de ficha en `$[N]`.
-- DESDE v5 SOLO ESCRIBEN SI EL VALOR CAMBIA. Antes cada guardado de `servers`/`seasons` costaba DOS
-- filas escritas (la del job y la de este disparador), aunque `enlace_permanente` quedara igual; y
-- la cuota que se agota en Turso es justo de filas escritas. Se recrean (DROP) porque
-- CREATE TRIGGER IF NOT EXISTS no cambia uno que ya existe.
DROP TRIGGER IF EXISTS trg_media_enlace_permanente_ins;
DROP TRIGGER IF EXISTS trg_media_enlace_permanente_upd;
CREATE TRIGGER IF NOT EXISTS trg_media_enlace_permanente_ins
AFTER INSERT ON media_items
BEGIN
    UPDATE media_items SET enlace_permanente = (
        EXISTS (SELECT 1 FROM json_each(NEW.servers) s
                WHERE json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM json_tree(NEW.seasons) s
                WHERE s.type = 'object'
                  AND s.fullkey GLOB '$[[]*].episodes[[]*].servers[[]*]'
                  AND json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
    )
    WHERE id = NEW.id AND enlace_permanente IS NOT (
        EXISTS (SELECT 1 FROM json_each(NEW.servers) s
                WHERE json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM json_tree(NEW.seasons) s
                WHERE s.type = 'object'
                  AND s.fullkey GLOB '$[[]*].episodes[[]*].servers[[]*]'
                  AND json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_media_enlace_permanente_upd
AFTER UPDATE OF servers, seasons ON media_items
BEGIN
    UPDATE media_items SET enlace_permanente = (
        EXISTS (SELECT 1 FROM json_each(NEW.servers) s
                WHERE json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM json_tree(NEW.seasons) s
                WHERE s.type = 'object'
                  AND s.fullkey GLOB '$[[]*].episodes[[]*].servers[[]*]'
                  AND json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
    )
    WHERE id = NEW.id AND enlace_permanente IS NOT (
        EXISTS (SELECT 1 FROM json_each(NEW.servers) s
                WHERE json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM json_tree(NEW.seasons) s
                WHERE s.type = 'object'
                  AND s.fullkey GLOB '$[[]*].episodes[[]*].servers[[]*]'
                  AND json_extract(s.value, '$.direct_mode') = 'public'
                  AND json_extract(s.value, '$.direct_stream') IS NOT NULL)
    );
END;

-- ── Lo que miden los aparatos (migraciones 008 y 013) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS playback_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    item_id       TEXT,
    episode_id    TEXT,
    server_host   TEXT,
    delivery_mode TEXT,
    outcome       TEXT NOT NULL DEFAULT 'unknown',
    ttff_ms       INTEGER,
    stalls        INTEGER,
    stalled_ms    INTEGER,
    failovers     INTEGER,
    avg_height    INTEGER,
    app_version   TEXT,
    kbps_medidos  INTEGER,
    reconexiones  INTEGER,
    conexiones    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_playback_recent ON playback_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_playback_host   ON playback_events (server_host, created_at DESC);

-- ── Subtítulos (migración 011) ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subtitulos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id       TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episodio_id    TEXT NOT NULL DEFAULT '',
    idioma         TEXT NOT NULL,
    etiqueta       TEXT NOT NULL,
    origen         TEXT NOT NULL CHECK (origen IN ('transcrito', 'traducido', 'publico')),
    desfase_ms     INTEGER,
    parecido       REAL,
    contenido      TEXT NOT NULL,
    modelo         TEXT,
    segundos_audio INTEGER,
    creado_en      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT subtitulos_unicos UNIQUE (media_id, episodio_id, idioma)
);
CREATE INDEX IF NOT EXISTS idx_subtitulos_ficha ON subtitulos (media_id, episodio_id);

CREATE TABLE IF NOT EXISTS subtitulos_cola (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id     TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episodio_id  TEXT NOT NULL DEFAULT '',
    prioridad    INTEGER NOT NULL DEFAULT 0,
    intentos     INTEGER NOT NULL DEFAULT 0,
    ultimo_error TEXT,
    pedido_en    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    hecho_en     TEXT,
    CONSTRAINT subtitulos_cola_unica UNIQUE (media_id, episodio_id)
);
CREATE INDEX IF NOT EXISTS idx_subtitulos_cola_pendiente ON subtitulos_cola (prioridad DESC, pedido_en) WHERE hecho_en IS NULL;

-- ── NetMirror (migraciones 015 y 016) ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS netmirror_cache (
    tmdb_id       INTEGER NOT NULL,
    temporada     INTEGER NOT NULL DEFAULT 0,
    episodio      INTEGER NOT NULL DEFAULT 0,
    disponible    INTEGER NOT NULL,
    resolucion    INTEGER,
    comprobado_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    netflix_id    TEXT,
    idiomas_audio TEXT,
    dominio_hls   TEXT,
    PRIMARY KEY (tmdb_id, temporada, episodio)
);
CREATE INDEX IF NOT EXISTS idx_netmirror_cache_comprobado ON netmirror_cache (comprobado_at);
CREATE INDEX IF NOT EXISTS idx_netmirror_cache_netflix    ON netmirror_cache (netflix_id) WHERE netflix_id IS NOT NULL;

-- ── Pool de sesiones NetMirror compartidas (2026-09-22) ──────────────────────────────────
--
-- CADA TELÉFONO QUE CONSIGUE `usertoken` LO SUBE Y TODOS SE APROVECHAN. NetMirror ata la sesión
-- a la IP del que la creó, así que un token del pool puede fallar cuando lo usa otro cliente;
-- por eso `ip_hash` guarda un hash corto para no reusar el token en la misma red donde ya se
-- rechazó. Un teléfono con OTP roto pide `GET /netmirror/session` en vez de rendirse; uno con
-- OTP sano lo sube por `POST /netmirror/session`, fire-and-forget.
CREATE TABLE IF NOT EXISTS netmirror_sesiones (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_token     TEXT NOT NULL UNIQUE,
    api_url        TEXT NOT NULL,
    ott            TEXT NOT NULL DEFAULT 'nf' CHECK (ott IN ('nf', 'pv', 'hs')),
    obtenido_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ultimo_uso_at  TEXT,
    ip_hash        TEXT,
    aciertos       INTEGER NOT NULL DEFAULT 0,
    fallos         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_netmirror_sesiones_recientes
    ON netmirror_sesiones (obtenido_at DESC, aciertos DESC);

-- ── Verificacion distribuida de NetMirror (migracion 021) ────────────────────────────────
-- GitHub/TMDB prepara candidatos sin tocar NewTV. Los aparatos voluntarios comprueban lotes
-- pequenos desde su propia red. Nunca se guarda la IP: `red_hash` solo permite exigir acuerdo
-- entre dos redes distintas antes de publicar y cambia si rota el secreto del servidor.
CREATE TABLE IF NOT EXISTS netmirror_trabajos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id         INTEGER NOT NULL,
    ott             TEXT NOT NULL CHECK (ott IN ('nf', 'pv', 'hs')),
    titulo          TEXT NOT NULL,
    titulo_original TEXT,
    anio            TEXT,
    prioridad       INTEGER NOT NULL DEFAULT 0,
    ronda           INTEGER NOT NULL DEFAULT 1,
    estado          TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'confirmado', 'descartado')),
    proxima_revision TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    creado_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actualizado_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT netmirror_trabajo_unico UNIQUE (tmdb_id, ott)
);
CREATE INDEX IF NOT EXISTS idx_netmirror_trabajos_cola
    ON netmirror_trabajos (estado, proxima_revision, prioridad DESC, actualizado_at);

CREATE TABLE IF NOT EXISTS netmirror_asignaciones (
    token             TEXT PRIMARY KEY,
    trabajo_id        INTEGER NOT NULL REFERENCES netmirror_trabajos(id) ON DELETE CASCADE,
    ronda             INTEGER NOT NULL,
    dispositivo_hash  TEXT NOT NULL,
    red_hash          TEXT NOT NULL,
    expira_at         TEXT NOT NULL,
    creado_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT netmirror_asignacion_unica UNIQUE (trabajo_id, ronda, dispositivo_hash)
);
CREATE INDEX IF NOT EXISTS idx_netmirror_asignaciones_expira ON netmirror_asignaciones (expira_at);

CREATE TABLE IF NOT EXISTS netmirror_verificaciones (
    trabajo_id        INTEGER NOT NULL REFERENCES netmirror_trabajos(id) ON DELETE CASCADE,
    ronda             INTEGER NOT NULL,
    dispositivo_hash  TEXT NOT NULL,
    red_hash          TEXT NOT NULL,
    resultado_hash    TEXT NOT NULL,
    resultado_json    TEXT NOT NULL,
    recibido_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (trabajo_id, ronda, dispositivo_hash)
);
CREATE INDEX IF NOT EXISTS idx_netmirror_verificaciones_quorum
    ON netmirror_verificaciones (trabajo_id, ronda, resultado_hash, red_hash);

-- Pluto TV: lo que el MÓVIL ve en su catálogo (Pluto decide por la IP; GitHub vería otro). El
-- aparato manda datos crudos y los audios del master; el importador identifica contra TMDB y
-- publica. Ver src/scrapers/pluto.ts.
CREATE TABLE IF NOT EXISTS pluto_titulos (
    pluto_id        TEXT PRIMARY KEY,
    nombre          TEXT NOT NULL,
    anio            INTEGER,
    minutos         INTEGER,
    directores      TEXT NOT NULL DEFAULT '[]',
    pais            TEXT,
    primera_vez_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    visto_at        TEXT NOT NULL,
    -- Idiomas de audio del master ('es', 'en'…), tal como los mira el móvil. NULL = sin mirar.
    audios          TEXT,
    audios_at       TEXT,
    -- 'verificada' | 'ambigua' | 'sin_director' | 'sin_anio' | 'nada'. NULL = sin identificar.
    veredicto       TEXT,
    tmdb_id         INTEGER,
    identificado_at TEXT,
    publicado_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pluto_titulos_veredicto ON pluto_titulos (veredicto, audios_at);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- VISTAS (migraciones 018, 019 y 020). Un servidor / un capítulo por fila, para que los barridos
-- pregunten sin bajarse el catálogo. Van con DROP + CREATE porque SQLite no tiene CREATE OR
-- REPLACE VIEW y una vista no guarda datos.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS muestra_por_host;
DROP VIEW IF EXISTS embeds_publicados;
DROP VIEW IF EXISTS servidores_publicados;
DROP VIEW IF EXISTS capitulos_por_comprobar;
DROP VIEW IF EXISTS capitulos_publicados;
DROP VIEW IF EXISTS servidores_sin_directo;

CREATE VIEW servidores_publicados AS
SELECT
    m.id                                    AS media_id,
    m.type                                  AS media_type,
    m.title                                 AS media_title,
    NULL                                    AS season_number,
    NULL                                    AS episode_number,
    json_extract(sv.value, '$.embed_url')     AS embed_url,
    json_extract(sv.value, '$.direct_stream') AS direct_stream,
    json_extract(sv.value, '$.direct_kind')   AS direct_kind,
    json_extract(sv.value, '$.status')        AS status,
    -- El host: lo que hay entre `://` (con o sin www.) y la primera barra.
    substr(
        replace(replace(replace(json_extract(sv.value, '$.embed_url'), 'https://', ''), 'http://', ''), 'www.', ''),
        1,
        CASE WHEN instr(replace(replace(replace(json_extract(sv.value, '$.embed_url'), 'https://', ''), 'http://', ''), 'www.', ''), '/') = 0
             THEN length(json_extract(sv.value, '$.embed_url'))
             ELSE instr(replace(replace(replace(json_extract(sv.value, '$.embed_url'), 'https://', ''), 'http://', ''), 'www.', ''), '/') - 1 END
    )                                       AS host,
    CASE WHEN json_extract(sv.value, '$.verified_at') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
         THEN json_extract(sv.value, '$.verified_at') END AS verified_at,
    CASE WHEN typeof(json_extract(sv.value, '$.fallos_entrega')) = 'integer'
         THEN json_extract(sv.value, '$.fallos_entrega') END AS fallos_entrega
FROM media_items m, json_each(CASE WHEN json_valid(m.servers) THEN m.servers ELSE '[]' END) sv
UNION ALL
SELECT
    m.id,
    m.type,
    m.title,
    json_extract(t.value, '$.season_number'),
    json_extract(e.value, '$.episode_number'),
    json_extract(sv.value, '$.embed_url'),
    json_extract(sv.value, '$.direct_stream'),
    json_extract(sv.value, '$.direct_kind'),
    json_extract(sv.value, '$.status'),
    substr(
        replace(replace(replace(json_extract(sv.value, '$.embed_url'), 'https://', ''), 'http://', ''), 'www.', ''),
        1,
        CASE WHEN instr(replace(replace(replace(json_extract(sv.value, '$.embed_url'), 'https://', ''), 'http://', ''), 'www.', ''), '/') = 0
             THEN length(json_extract(sv.value, '$.embed_url'))
             ELSE instr(replace(replace(replace(json_extract(sv.value, '$.embed_url'), 'https://', ''), 'http://', ''), 'www.', ''), '/') - 1 END
    ),
    CASE WHEN json_extract(sv.value, '$.verified_at') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
         THEN json_extract(sv.value, '$.verified_at') END,
    CASE WHEN typeof(json_extract(sv.value, '$.fallos_entrega')) = 'integer'
         THEN json_extract(sv.value, '$.fallos_entrega') END
FROM media_items m,
     json_each(CASE WHEN json_valid(m.seasons) THEN m.seasons ELSE '[]' END) t,
     json_each(COALESCE(json_extract(t.value, '$.episodes'), '[]')) e,
     json_each(COALESCE(json_extract(e.value, '$.servers'), '[]')) sv;

-- Un embed publicado por fila, con su sello más fresco y las fichas que lo llevan. Para --verificar.
CREATE VIEW embeds_publicados AS
SELECT
    embed_url,
    max(verified_at)                    AS sello,
    count(*)                            AS apariciones,
    json_group_array(DISTINCT media_id) AS fichas
FROM servidores_publicados
WHERE embed_url IS NOT NULL
  AND direct_stream IS NOT NULL
  -- Pluto solo lo abre el móvil (pluto://): ni --verificar ni --purge pueden juzgarlo.
  AND embed_url NOT LIKE 'pluto://%'
GROUP BY embed_url;

-- Hasta ocho servidores por host, el sello más fresco primero. Para --entrega.
CREATE VIEW muestra_por_host AS
SELECT media_id, media_type, media_title, embed_url, direct_stream, direct_kind, status, verified_at, host, puesto
FROM (
    SELECT sp.*,
           row_number() OVER (PARTITION BY host ORDER BY verified_at DESC) AS puesto
    FROM servidores_publicados sp
    -- Sin Pluto: --entrega lo envolvería en /stream/direct, daría 400 y le quitaría el sello.
    WHERE embed_url IS NOT NULL AND direct_stream IS NOT NULL AND embed_url NOT LIKE 'pluto://%'
)
WHERE puesto <= 8;

-- Cada capítulo de cada serie como fila, con su sello checked_at.
CREATE VIEW capitulos_publicados AS
SELECT
    m.id          AS media_id,
    m.title       AS media_title,
    m.has_streams AS has_streams,
    CASE WHEN typeof(json_extract(t.value, '$.season_number')) = 'integer'
         THEN json_extract(t.value, '$.season_number')
         WHEN json_extract(t.value, '$.season_number') GLOB '[0-9]*'
         THEN CAST(json_extract(t.value, '$.season_number') AS INTEGER) END AS season_number,
    CASE WHEN typeof(json_extract(e.value, '$.episode_number')) = 'integer'
         THEN json_extract(e.value, '$.episode_number')
         WHEN json_extract(e.value, '$.episode_number') GLOB '[0-9]*'
         THEN CAST(json_extract(e.value, '$.episode_number') AS INTEGER) END AS episode_number,
    CASE WHEN json_extract(e.value, '$.checked_at') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'
         THEN json_extract(e.value, '$.checked_at') END AS checked_at
FROM media_items m,
     json_each(CASE WHEN json_valid(m.seasons) THEN m.seasons ELSE '[]' END) t,
     json_each(COALESCE(json_extract(t.value, '$.episodes'), '[]')) e
WHERE m.type = 'tvseries';

-- Capítulos sin sello o con sello de más de 7 días, con cuántos le faltan a su serie. Para --episodios.
CREATE VIEW capitulos_por_comprobar AS
SELECT
    c.media_id, c.media_title, c.has_streams, c.season_number, c.episode_number, c.checked_at,
    count(*) OVER (PARTITION BY c.media_id) AS faltan
FROM capitulos_publicados c
WHERE c.season_number IS NOT NULL
  AND c.episode_number IS NOT NULL
  AND (c.checked_at IS NULL OR c.checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'));

-- Servidores de ficha (no de capítulo) con embed y sin direct_stream. Para refreshCatalog --direct.
CREATE VIEW servidores_sin_directo AS
SELECT
    m.id                 AS media_id,
    m.type               AS media_type,
    m.streams_updated_at AS streams_updated_at,
    json_extract(sv.value, '$.embed_url') AS embed_url
FROM media_items m, json_each(CASE WHEN json_valid(m.servers) THEN m.servers ELSE '[]' END) sv
WHERE COALESCE(json_extract(sv.value, '$.embed_url'), '') <> ''
  AND COALESCE(json_extract(sv.value, '$.direct_stream'), '') = '';
