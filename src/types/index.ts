export type ContentType = 'movie' | 'tvseries';
export type LinkStatus = 'online' | 'offline' | 'checking';

export interface ServerOption {
  id: string;
  name: string;
  quality: '4K' | '1080p' | '720p' | '480p';
  language: 'latino' | 'subtitulado' | 'castellano';
  embed_url: string;
  direct_stream?: string;
  headers?: Record<string, string>;
  status: LinkStatus;
  last_checked: string;
  source_id?: string;
  source_priority?: number;
}

export interface CastMember {
  name: string;
  character: string;
  photo: string | null;
}

export interface DubbingMember {
  character: string;
  voice_actor: string;
}

export interface Episode {
  episode_number: number;
  name: string;
  original_name?: string;
  overview: string;
  still_path: string | null;
  air_date: string | null;
  primary_stream?: ServerOption;
  servers: ServerOption[];
}

export interface Season {
  season_number: number;
  name: string;
  episodes_count: number;
  poster: string | null;
  episodes: Episode[];
}

export interface MediaItem {
  id: string;
  tmdb_id: number;
  imdb_id: string | null;
  type: ContentType;
  title: string;
  original_title: string;
  aliases: string[];
  tagline?: string;
  overview: string;
  rating: number;
  content_rating?: string;
  release_date?: string;
  genres: string[];
  subcategories: string[];
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
  trailer: string | null;
  cast: string[];
  cast_details?: CastMember[];
  dubbing_cast: DubbingMember[];
  /** Duración en minutos (película) o duración media del episodio (serie). */
  runtime?: number;
  /** Director de la película. En series se usa created_by. */
  director?: string;
  created_by?: string[];
  /** Origen de la metadata: 'tmdb' (match verificado) o 'source' (fallback al sitio scrapeado). */
  metadata_source?: 'tmdb' | 'source';
  // Solo para películas
  primary_stream?: ServerOption;
  servers?: ServerOption[];
  /** ISO de la última resolución de enlaces (columna streams_updated_at). */
  streams_updated_at?: string | null;
  /** URL del detalle en la fuente. Interno: no se serializa al cliente. */
  _source_url?: string;
  // Solo para series
  total_seasons?: number;
  total_episodes?: number;
  seasons?: Season[];
}

/**
 * Estado de los enlaces en una respuesta de detalle. La metadata se devuelve al
 * instante; si los servidores todavía no están resueltos el cliente los pide a
 * `url` en el momento de reproducir (ver src/routes/media.routes.ts).
 */
export interface StreamsStatus {
  status: 'ready' | 'pending';
  url: string;
  updated_at: string | null;
}

/** Pista de render para el cliente: cómo debe dibujarse el carrusel. */
export type RowLayout = 'ranked' | 'backdrop' | 'poster';

export interface HomeFeedRow {
  id: string;
  title: string;
  subtitle?: string;
  type: 'featured' | 'carousel';
  layout: RowLayout;
  items: Partial<MediaItem>[];
  /** Endpoint para el "ver todo" / scroll infinito de la fila. */
  endpoint?: string;
}

export interface HomeFeedResponse {
  featured: Partial<MediaItem> | null;
  /** Rotación del hero: varios destacados con metadata completa. */
  spotlight: Partial<MediaItem>[];
  rows: HomeFeedRow[];
  updated_at: string;
}
