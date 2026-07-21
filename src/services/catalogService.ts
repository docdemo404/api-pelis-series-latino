import { MediaItem, ServerOption } from '../types';
import { supabase } from './supabaseService';

const richLatinoCatalog: MediaItem[] = [
  {
    id: 'mi-pobre-angelito',
    tmdb_id: 771,
    imdb_id: 'tt0099785',
    type: 'movie',
    title: 'Mi pobre angelito',
    original_title: 'Home Alone',
    aliases: ['Solo en casa', 'Mi pobre angelito', 'Home Alone', 'Mi pobre angelito 1'],
    tagline: 'Una comedia familiar sin familia',
    overview: 'Un niño de 8 años accidentalmente olvidado en casa durante las vacaciones de Navidad debe defender su hogar de dos torpes ladrones.',
    rating: 7.4,
    content_rating: 'PG',
    release_date: '1990-11-16',
    genres: ['Comedia', 'Familia'],
    subcategories: ['Navidad', 'Clásicos', 'Niños'],
    poster: 'https://image.tmdb.org/t/p/w500/vLvhGgqCq7k...jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/96...jpg',
    logo: 'https://image.tmdb.org/t/p/original/logo_home_alone.png',
    trailer: 'https://www.youtube.com/watch?v=CK2Btk6k2m4',
    cast: [
      { name: 'Macaulay Culkin', character: 'Kevin McCallister', photo: 'https://image.tmdb.org/t/p/w185/macaulay.jpg' },
      { name: 'Joe Pesci', character: 'Harry', photo: 'https://image.tmdb.org/t/p/w185/pesci.jpg' }
    ],
    dubbing_cast: [
      { character: 'Kevin McCallister', voice_actor: 'Laura Torres (Latino)' }
    ],
    primary_stream: {
      id: 'srv_ha_1',
      name: 'Streamwish',
      quality: '1080p',
      language: 'latino',
      embed_url: 'https://streamwish.to/e/home_alone_lat',
      direct_stream: 'https://streamwish.to/hls/home_alone_lat.m3u8',
      status: 'online',
      last_checked: new Date().toISOString()
    },
    servers: [
      {
        id: 'srv_ha_1',
        name: 'Streamwish',
        quality: '1080p',
        language: 'latino',
        embed_url: 'https://streamwish.to/e/home_alone_lat',
        direct_stream: 'https://streamwish.to/hls/home_alone_lat.m3u8',
        status: 'online',
        last_checked: new Date().toISOString()
      }
    ]
  },
  {
    id: 'los-simpson',
    tmdb_id: 456,
    imdb_id: 'tt0096697',
    type: 'tvseries',
    title: 'Los Simpson',
    original_title: 'The Simpsons',
    aliases: ['The Simpsons', 'Los Simpsons', 'Los Simpson'],
    tagline: 'La familia más famosa del mundo',
    overview: 'Sátira de la clase media estadounidense ambientada en la ciudad de Springfield.',
    rating: 8.0,
    content_rating: 'TV-14',
    release_date: '1989-12-17',
    genres: ['Animación', 'Comedia'],
    subcategories: ['Familia disfuncional', 'Springfield', 'Sátira'],
    poster: 'https://image.tmdb.org/t/p/w500/kB2...jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/96...jpg',
    logo: 'https://image.tmdb.org/t/p/original/logo_simpsons.png',
    trailer: 'https://www.youtube.com/watch?v=DXUAyRRkI6c',
    cast: [
      { name: 'Dan Castellaneta', character: 'Homer Simpson', photo: 'https://image.tmdb.org/t/p/w185/dan.jpg' }
    ],
    dubbing_cast: [
      { character: 'Homero Simpson', voice_actor: 'Humberto Vélez (Latino)' },
      { character: 'Bart Simpson', voice_actor: 'Marina Huerta (Latino)' }
    ],
    total_seasons: 35,
    total_episodes: 760,
    seasons: [
      {
        season_number: 1,
        name: 'Temporada 1',
        episodes_count: 13,
        poster: 'https://image.tmdb.org/t/p/w500/season1.jpg',
        episodes: [
          {
            episode_number: 1,
            name: 'Especial de Navidad de los Simpson',
            original_name: 'Simpsons Roasting on an Open Fire',
            overview: 'Cuando se cancela el bono de Navidad de Homero...',
            still_path: 'https://image.tmdb.org/t/p/w500/still1.jpg',
            air_date: '1989-12-17',
            primary_stream: {
              id: 'srv_simpson_s1e1',
              name: 'Streamwish',
              quality: '1080p',
              language: 'latino',
              embed_url: 'https://streamwish.to/e/simpsons_s1e1',
              direct_stream: 'https://streamwish.to/hls/simpsons_s1e1.m3u8',
              status: 'online',
              last_checked: new Date().toISOString()
            },
            servers: [
              {
                id: 'srv_simpson_s1e1',
                name: 'Streamwish',
                quality: '1080p',
                language: 'latino',
                embed_url: 'https://streamwish.to/e/simpsons_s1e1',
                direct_stream: 'https://streamwish.to/hls/simpsons_s1e1.m3u8',
                status: 'online',
                last_checked: new Date().toISOString()
              }
            ]
          }
        ]
      }
    ]
  },
  {
    id: 'intensamente-2',
    tmdb_id: 1022789,
    imdb_id: 'tt22022452',
    type: 'movie',
    title: 'Intensamente 2',
    original_title: 'Inside Out 2',
    aliases: ['Inside Out 2', 'Del revés 2', 'Intensamente 2'],
    tagline: 'Haz espacio para nuevas emociones',
    overview: 'Riley entra en la adolescencia y su sede central sufre una demolición repentina para hacer sitio a nuevas emociones.',
    rating: 7.7,
    content_rating: 'PG',
    release_date: '2024-06-11',
    genres: ['Animación', 'Familia', 'Aventura'],
    subcategories: ['Disney', 'Pixar', 'Estrenos 2024'],
    poster: 'https://image.tmdb.org/t/p/w500/vpnP5z356.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/xg270y.jpg',
    logo: 'https://image.tmdb.org/t/p/original/logo_insideout2.png',
    trailer: 'https://www.youtube.com/watch?v=LEjhY15eCx0',
    cast: [
      { name: 'Amy Poehler', character: 'Joy', photo: null }
    ],
    dubbing_cast: [
      { character: 'Alegría', voice_actor: 'Cristina Hernández (Latino)' },
      { character: 'Ansiedad', voice_actor: 'Pamela Mendoza (Latino)' }
    ],
    primary_stream: {
      id: 'srv_io2_1',
      name: 'Streamwish',
      quality: '1080p',
      language: 'latino',
      embed_url: 'https://streamwish.to/e/insideout2_lat',
      direct_stream: 'https://streamwish.to/hls/insideout2_lat.m3u8',
      status: 'online',
      last_checked: new Date().toISOString()
    }
  },
  {
    id: 'deadpool-y-wolverine',
    tmdb_id: 533535,
    imdb_id: 'tt6263850',
    type: 'movie',
    title: 'Deadpool & Wolverine',
    original_title: 'Deadpool & Wolverine',
    aliases: ['Deadpool 3', 'Deadpool y Lobezno', 'Deadpool & Wolverine'],
    tagline: 'Todos merecen un final feliz',
    overview: 'Un apático Deadpool trabaja en la vida civil cuando la TVA le encomienda una misión que pondrá a prueba su alianza con Wolverine.',
    rating: 7.9,
    content_rating: 'R',
    release_date: '2024-07-24',
    genres: ['Acción', 'Comedia', 'Ciencia Ficción'],
    subcategories: ['Marvel', 'MCU', 'Estrenos 2024'],
    poster: 'https://image.tmdb.org/t/p/w500/8cdWjv72.jpg',
    backdrop: 'https://image.tmdb.org/t/p/original/yDHYT.jpg',
    logo: 'https://image.tmdb.org/t/p/original/logo_deadpool.png',
    trailer: 'https://www.youtube.com/watch?v=73_14844654',
    cast: [
      { name: 'Ryan Reynolds', character: 'Wade Wilson / Deadpool', photo: null },
      { name: 'Hugh Jackman', character: 'Logan / Wolverine', photo: null }
    ],
    dubbing_cast: [
      { character: 'Deadpool', voice_actor: 'Pepe Toño Macías (Latino)' },
      { character: 'Wolverine', voice_actor: 'Humberto Solórzano (Latino)' }
    ],
    primary_stream: {
      id: 'srv_dw_1',
      name: 'Streamwish',
      quality: '1080p',
      language: 'latino',
      embed_url: 'https://streamwish.to/e/deadpool_wolverine_lat',
      direct_stream: 'https://streamwish.to/hls/deadpool_wolverine_lat.m3u8',
      status: 'online',
      last_checked: new Date().toISOString()
    }
  }
];

export class CatalogService {
  /**
   * Obtiene todos los títulos (Combina Supabase + Catálogo Base Latino)
   */
  static async getAll(): Promise<MediaItem[]> {
    try {
      const { data, error } = await supabase.from('media_items').select('*').limit(50);
      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }
    } catch (err) {
      // Ignore DB errors and fallback
    }
    return richLatinoCatalog;
  }

  /**
   * Obtiene un título por ID o Slug
   */
  static async getById(id: string): Promise<MediaItem | null> {
    const q = id.toLowerCase().trim();
    const localMatch = richLatinoCatalog.find(i => i.id === q || i.tmdb_id.toString() === q);
    if (localMatch) return localMatch;

    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`id.eq.${q},tmdb_id.eq.${isNaN(Number(q)) ? -1 : Number(q)}`)
        .single();

      if (data) return this.mapDbItemToMediaItem(data);
    } catch (err) {
      // Ignore
    }

    return null;
  }

  /**
   * Búsqueda por texto o alias
   */
  static async search(query: string): Promise<MediaItem[]> {
    const q = query.toLowerCase().trim();
    const localMatches = richLatinoCatalog.filter(item => {
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchOriginal = item.original_title.toLowerCase().includes(q);
      const matchAlias = item.aliases.some(alias => alias.toLowerCase().includes(q));
      return matchTitle || matchOriginal || matchAlias;
    });

    if (localMatches.length > 0) {
      return localMatches;
    }

    try {
      const { data } = await supabase
        .from('media_items')
        .select('*')
        .or(`title.ilike.%${q}%,original_title.ilike.%${q}%`);

      if (data && data.length > 0) {
        return data.map(this.mapDbItemToMediaItem);
      }
    } catch (err) {
      // Ignore
    }

    return [];
  }

  private static mapDbItemToMediaItem(dbRow: any): MediaItem {
    return {
      id: dbRow.id,
      tmdb_id: dbRow.tmdb_id,
      imdb_id: dbRow.imdb_id || null,
      type: dbRow.type,
      title: dbRow.title,
      original_title: dbRow.original_title,
      aliases: dbRow.aliases || [],
      tagline: dbRow.tagline || '',
      overview: dbRow.overview || '',
      rating: dbRow.rating || 0.0,
      content_rating: dbRow.content_rating || 'PG-13',
      release_date: dbRow.release_date || '',
      genres: dbRow.genres || [],
      subcategories: dbRow.subcategories || [],
      poster: dbRow.poster || null,
      backdrop: dbRow.backdrop || null,
      logo: dbRow.logo || null,
      trailer: dbRow.trailer || null,
      cast: dbRow.cast_data || [],
      dubbing_cast: dbRow.dubbing_cast_data || [],
      total_seasons: dbRow.total_seasons || 0,
      total_episodes: dbRow.total_episodes || 0,
      primary_stream: {
        id: `srv_${dbRow.id}_1`,
        name: 'Streamwish',
        quality: '1080p',
        language: 'latino',
        embed_url: `https://streamwish.to/e/${dbRow.id}`,
        direct_stream: `https://streamwish.to/hls/${dbRow.id}.m3u8`,
        status: 'online',
        last_checked: new Date().toISOString()
      }
    };
  }
}
