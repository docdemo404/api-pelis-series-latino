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
  // Solo para películas
  primary_stream?: ServerOption;
  servers?: ServerOption[];
  // Solo para series
  total_seasons?: number;
  total_episodes?: number;
  seasons?: Season[];
}

export interface HomeFeedRow {
  id: string;
  title: string;
  type: 'featured' | 'carousel';
  items: MediaItem[];
}

export interface HomeFeedResponse {
  featured: MediaItem | null;
  rows: HomeFeedRow[];
}
