-- Esquema SQL Optimizado para Supabase PostgreSQL (Catálogo Gigante de Películas y Series)

-- 1. Tabla Principal de Películas y Series
CREATE TABLE IF NOT EXISTS media_items (
    id VARCHAR(255) PRIMARY KEY,
    tmdb_id INT UNIQUE NOT NULL,
    imdb_id VARCHAR(50),
    type VARCHAR(20) NOT NULL CHECK (type IN ('movie', 'tvseries')),
    title VARCHAR(500) NOT NULL,
    original_title VARCHAR(500) NOT NULL,
    title_normalized TEXT,
    aliases TEXT[] DEFAULT '{}',
    tagline TEXT,
    overview TEXT,
    rating NUMERIC(3, 1) DEFAULT 0.0,
    content_rating VARCHAR(20),
    release_date VARCHAR(50),
    genres TEXT[] DEFAULT '{}',
    subcategories TEXT[] DEFAULT '{}',
    poster TEXT,
    backdrop TEXT,
    logo TEXT,
    trailer TEXT,
    cast_data JSONB DEFAULT '[]'::jsonb,
    dubbing_cast_data JSONB DEFAULT '[]'::jsonb,
    runtime INT,
    director TEXT,
    total_seasons INT DEFAULT 0,
    total_episodes INT DEFAULT 0,
    -- Enlaces persistidos: evitan scrapear en vivo al abrir una ficha (ver migración 004)
    servers JSONB DEFAULT '[]'::jsonb,
    seasons JSONB DEFAULT '[]'::jsonb,
    source_url TEXT,
    streams_updated_at TIMESTAMP WITH TIME ZONE,
    -- Todas las páginas de origen de la MISMA ficha (una por fuente). Permite unificar
    -- los servidores de TioPlus y FuegoCine bajo un único registro. Ver migración 005.
    source_urls TEXT[] DEFAULT '{}',
    -- Disponibilidad verificada: TRUE con enlaces, FALSE fantasma (se oculta de los
    -- feeds), NULL sin comprobar (se sigue mostrando). Ver migración 005.
    has_streams BOOLEAN,
    streams_checked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Desactivar RLS o permitir acceso de lectura/escritura público para la API
ALTER TABLE media_items DISABLE ROW LEVEL SECURITY;

-- 2. Índices de Búsqueda Instantánea (< 10ms)
CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type);
CREATE INDEX IF NOT EXISTS idx_media_title ON media_items USING gin(to_tsvector('spanish', title));
CREATE INDEX IF NOT EXISTS idx_media_aliases ON media_items USING gin(aliases);

-- Búsqueda por PREFIJO en milisegundos (ilike 'q%' sobre título normalizado sin acentos,
-- mantenido por scripts/refreshCatalog.ts). Ver src/db/migrations/001_search_prefix_index.sql
CREATE INDEX IF NOT EXISTS idx_media_title_norm_prefix ON media_items (title_normalized text_pattern_ops);

-- Orden por frescura para el getAll DB-first del catálogo
CREATE INDEX IF NOT EXISTS idx_media_updated_at ON media_items (updated_at DESC);

-- Carruseles del home y discover paginado en la DB. Ver src/db/migrations/004_streams_and_rich_metadata.sql
CREATE INDEX IF NOT EXISTS idx_media_type_rating ON media_items (type, rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_media_genres ON media_items USING gin (genres);
CREATE INDEX IF NOT EXISTS idx_media_streams_updated ON media_items (streams_updated_at DESC NULLS LAST);

-- Feeds sin fichas fantasma. Ver src/db/migrations/005_multisource_and_availability.sql
CREATE INDEX IF NOT EXISTS idx_media_playable ON media_items (updated_at DESC) WHERE has_streams IS DISTINCT FROM false;
CREATE INDEX IF NOT EXISTS idx_media_streams_checked ON media_items (streams_checked_at DESC NULLS FIRST);
