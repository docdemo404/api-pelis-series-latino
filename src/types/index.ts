export type ContentType = 'movie' | 'tvseries';
export type LinkStatus = 'online' | 'offline' | 'checking';

/**
 * Cómo se sirve el vídeo directo de un servidor, del más rápido al más caro:
 *
 *   public   → la URL extraída no caduca ni va atada a una IP: se guarda y se entrega tal cual.
 *   redirect → la URL caduca, pero el CDN la sirve a cualquier red: `direct_stream` acuña una
 *              recién hecha y responde 302. NO pasa ni un byte de vídeo por esta API, así que
 *              reproduce a la velocidad del CDN del host y no consume tránsito del plan.
 *   proxy    → el CDN valida la IP que acuñó la URL (o exige cabeceras que el cliente no puede
 *              poner), así que hay que reenviar los bytes desde aquí. Es el último recurso.
 *
 * Qué modo toca lo decide `bestMode` (src/scrapers/hostPolicy.ts) a partir de mediciones reales
 * por host, no de suposiciones.
 */
export type DirectMode = 'public' | 'redirect' | 'proxy';

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
   * Salvo en modo `public`, es una URL de esta misma API (`/api/v1/stream/direct?e=…`):
   * permanente y sin token de cara al cliente, aunque por debajo la URL del CDN se acuñe en cada
   * reproducción, porque todos los hosts la firman con caducidad. Funciona en CUALQUIER
   * reproductor sin que el cliente tenga que saber nada: según el host, responderá con un 302 al
   * CDN (`redirect`) o reenviará los bytes (`proxy`).
   */
  direct_stream?: string;
  direct_kind?: 'hls' | 'mp4';
  /** Qué hará `direct_stream` con este servidor. Ver DirectMode. */
  direct_mode?: DirectMode;
  /** Host del CDN que sirve el vídeo (`acek-cdn.com`, `okcdn.ru`…). Informativo. */
  direct_host?: string;
  /**
   * Cabeceras que exige el CDN de este host.
   *
   * Solo sirven a los clientes que puedan fijarlas —ExoPlayer, AVPlayer, VLC—, y son su billete
   * para pedir `direct_stream` con `?mode=redirect` y saltarse el proxy incluso en los hosts que
   * por defecto no lo permiten. Un navegador debe ignorarlas: `Referer` y `User-Agent` son
   * cabeceras prohibidas en fetch/XHR, y por eso a un navegador nunca se le ofrece `redirect`
   * cuando hacen falta.
   */
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
