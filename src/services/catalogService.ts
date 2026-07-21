import { MediaItem, ServerOption } from '../types';
import { TmdbService } from './tmdbService';
import { getPrimaryStream } from './streamSorter';

/**
 * Base de Datos en Memoria con Caché Indexado
 * Soporta búsquedas instantáneas por título, alias, ID y filtrado estilo Netflix.
 */
class MockDatabaseService {
  private items: Map<string, MediaItem> = new Map();

  constructor() {
    this.seedInitialCatalog();
  }

  private async seedInitialCatalog() {
    // 1. Sembrar Película Ejemplo: "Mi Pobre Angelito" (Home Alone)
    const homeAloneServers: ServerOption[] = [
      {
        id: 'srv_ha_1',
        name: 'Streamwish',
        quality: '1080p',
        language: 'latino',
        embed_url: 'https://streamwish.to/e/home_alone_lat',
        direct_stream: 'https://streamwish.to/hls/home_alone_lat.m3u8',
        status: 'online',
        last_checked: new Date().toISOString()
      },
      {
        id: 'srv_ha_2',
        name: 'Mega',
        quality: '720p',
        language: 'latino',
        embed_url: 'https://mega.nz/embed/home_alone_lat',
        status: 'online',
        last_checked: new Date().toISOString()
      }
    ];

    const homeAloneMeta = await TmdbService.getFullDetails(771, 'movie');
    const homeAloneItem: MediaItem = {
      id: 'mi-pobre-angelito',
      tmdb_id: 771,
      imdb_id: 'tt0099785',
      type: 'movie',
      title: homeAloneMeta.title || 'Mi pobre angelito',
      original_title: homeAloneMeta.original_title || 'Home Alone',
      aliases: ['Solo en casa', 'Mi pobre angelito', 'Home Alone', 'Mi pobre angelito 1'],
      tagline: homeAloneMeta.tagline,
      overview: homeAloneMeta.overview || '',
      rating: homeAloneMeta.rating || 7.4,
      content_rating: 'PG',
      release_date: '1990-11-16',
      genres: ['Comedia', 'Familia'],
      subcategories: ['Navidad', 'Clásicos', 'Niños'],
      poster: homeAloneMeta.poster || null,
      backdrop: homeAloneMeta.backdrop || null,
      logo: homeAloneMeta.logo || null,
      trailer: homeAloneMeta.trailer || null,
      cast: homeAloneMeta.cast || [],
      dubbing_cast: [
        { character: 'Kevin McCallister', voice_actor: 'Laura Torres (Latino)' }
      ],
      primary_stream: getPrimaryStream(homeAloneServers),
      servers: homeAloneServers
    };
    this.items.set(homeAloneItem.id, homeAloneItem);

    // 2. Sembrar Serie Ejemplo: "Los Simpson"
    const simpsonsMeta = await TmdbService.getFullDetails(456, 'tvseries');
    const simpsonsItem: MediaItem = {
      id: 'los-simpson',
      tmdb_id: 456,
      imdb_id: 'tt0096697',
      type: 'tvseries',
      title: simpsonsMeta.title || 'Los Simpson',
      original_title: simpsonsMeta.original_title || 'The Simpsons',
      aliases: ['The Simpsons', 'Los Simpsons', 'Los Simpson'],
      tagline: simpsonsMeta.tagline,
      overview: simpsonsMeta.overview || '',
      rating: simpsonsMeta.rating || 8.0,
      content_rating: 'TV-14',
      release_date: '1989-12-17',
      genres: ['Animación', 'Comedia'],
      subcategories: ['Familia disfuncional', 'Springfield', 'Sátira'],
      poster: simpsonsMeta.poster || null,
      backdrop: simpsonsMeta.backdrop || null,
      logo: simpsonsMeta.logo || null,
      trailer: simpsonsMeta.trailer || null,
      cast: simpsonsMeta.cast || [],
      dubbing_cast: [
        { character: 'Homero Simpson', voice_actor: 'Humberto Vélez (Latino)' },
        { character: 'Bart Simpson', voice_actor: 'Marina Huerta (Latino)' }
      ],
      total_seasons: simpsonsMeta.total_seasons || 35,
      total_episodes: simpsonsMeta.total_episodes || 760,
      seasons: simpsonsMeta.seasons || []
    };
    this.items.set(simpsonsItem.id, simpsonsItem);
  }

  public getAll(): MediaItem[] {
    return Array.from(this.items.values());
  }

  public getById(id: string): MediaItem | undefined {
    return this.items.get(id) || Array.from(this.items.values()).find(i => i.id === id || i.tmdb_id.toString() === id);
  }

  public search(query: string): MediaItem[] {
    const q = query.toLowerCase().trim();
    return Array.from(this.items.values()).filter(item => {
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchOriginal = item.original_title.toLowerCase().includes(q);
      const matchAlias = item.aliases.some(alias => alias.toLowerCase().includes(q));
      return matchTitle || matchOriginal || matchAlias;
    });
  }
}

export const dbService = new MockDatabaseService();
