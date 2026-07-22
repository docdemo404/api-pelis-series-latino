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
    total_seasons INT DEFAULT 0,
    total_episodes INT DEFAULT 0,
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
