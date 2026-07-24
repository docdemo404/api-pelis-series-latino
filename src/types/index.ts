export type ContentType = 'movie' | 'tvseries';
export type LinkStatus = 'online' | 'offline' | 'checking';

/**
 * Cómo se sirve el vídeo directo de un servidor:
 *   public → la URL extraída no caduca ni va atada a una IP: se guarda y se entrega tal cual.
 *   proxy  → la URL caduca o va atada a la red que la pidió, así que NO se guarda: `direct_stream`
 *            apunta a esta API, que la acuña en el momento de reproducir.
 */
export type DirectMode = 'public' | 'proxy';

export interface ServerOption {
  id: string;
  name: string;
  quality: '4K' | '1080p' | '720p' | '480p';
  language: 'latino' | 'subtitulado' | 'castellano';
  /** Reproductor de terceros. Es el ÚLTIMO recurso: solo si `direct_stream` falla. */
  embed_url: string;
  /**
   * Vídeo real (m3u8/mp4). Es la fuente PRIORITARIA y lo que el cliente debe intentar primero.
   *
   * Con `direct_mode: 'proxy'` es una URL de esta misma API (`/api/v1/stream/direct?e=…`):
   * permanente y sin token de cara al cliente, aunque por debajo se acuñe en cada reproducción.
   * Ningún host conocido permite hoy publicar la URL cruda del CDN — todos la firman y la atan
   * a la IP que la pidió. Ver src/scrapers/directStream.ts.
   */
  direct_stream?: string;
  direct_kind?: 'hls' | 'mp4';
  direct_mode?: DirectMode;
  /** Host del CDN que sirve el vídeo (`acek-cdn.com`, `okcdn.ru`…). Informativo. */
  direct_host?: string;
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
  /**
   * Veredicto de disponibilidad: `true` = se le conocen enlaces, `false` = se comprobó a
   * fondo y NO tiene ninguno (ficha fantasma), `undefined` = nunca se ha comprobado.
   * La distinción importa: solo lo verificado como vacío se oculta de home y búsqueda;
   * lo no comprobado se sigue mostrando.
   */
  has_streams?: boolean;
  /** ISO de la última COMPROBACIÓN de disponibilidad (haya dado enlaces o no). */
  streams_checked_at?: string | null;
  /** URL del detalle en la fuente. Interno: no se serializa al cliente. */
  _source_url?: string;
  /**
   * TODAS las URLs de origen de la ficha (una por fuente). La misma película existe en
   * TioPlus y en FuegoCine con slugs distintos; al unificarlas en una sola entidad hay que
   * conservar las dos, o los servidores de la fuente absorbida se pierden.
   * Interno: no se serializa al cliente.
   */
  _source_urls?: string[];
  // Solo para series
  total_seasons?: number;
  total_episodes?: number;
  seasons?: Season[];
}

/**
 * Estado de los enlaces en una respuesta de detalle. La metadata se devuelve al
 * instante; si los servidores todavía no están resueltos el cliente los pide a
 * `url` en el momento de reproducir (ver src/routes/media.routes.ts).
 *
 * Son TRES estados, no dos:
 *   ready       → hay servidores en la respuesta.
 *   pending     → aún no se han resuelto; pídelos a `url`.
 *   unavailable → ya se buscaron a fondo en todas las fuentes y no hay ninguno.
 * Devolver `pending` para este último caso dejaba a la app esperando indefinidamente
 * unos enlaces que no existen.
 */
export interface StreamsStatus {
  status: 'ready' | 'pending' | 'unavailable';
  url: string;
  updated_at: string | null;
  /** ISO de la última comprobación a fondo, o null si nunca se ha hecho. */
  checked_at?: string | null;
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
