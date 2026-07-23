import { HomeFeedResponse, HomeFeedRow, MediaItem, RowLayout } from '../types';
import { CatalogService } from './catalogService';
import { TmdbService } from './tmdbService';
import { CacheStore } from '../cache/store';

const HOME_TTL_SECONDS = 10 * 60;

/** Ítems mínimos para que una fila se muestre: por debajo, el carrusel se ve incompleto. */
const MIN_ROW_ITEMS = 8;

/** Veces que un mismo título puede repetirse entre carruseles (el hero no cuenta). */
const MAX_ROW_REPEATS = 2;

/** Nombre del país para el titular del Top 10. */
const COUNTRY_NAMES: Record<string, string> = {
  CL: 'Chile', MX: 'México', AR: 'Argentina', CO: 'Colombia', PE: 'Perú',
  EC: 'Ecuador', VE: 'Venezuela', UY: 'Uruguay', PY: 'Paraguay', BO: 'Bolivia',
  CR: 'Costa Rica', GT: 'Guatemala', HN: 'Honduras', SV: 'El Salvador',
  NI: 'Nicaragua', PA: 'Panamá', DO: 'República Dominicana', PR: 'Puerto Rico',
  CU: 'Cuba', ES: 'España', US: 'Estados Unidos'
};

function norm(text: string): string {
  return (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Sinopsis de relleno generada por el scraper cuando TMDB no aportó nada
 * ("Ver X online gratis en HD…"). Sirve para una tarjeta, no para el hero.
 */
function hasRealOverview(item: MediaItem): boolean {
  const o = (item.overview || '').trim();
  return o.length > 60 && !/^ver\s/i.test(o);
}

/** PRNG determinista (mulberry32) a partir de una semilla textual. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Baraja estable DENTRO del día: el home se siente vivo entre jornadas pero no cambia
 * de orden entre dos peticiones seguidas (y por tanto se puede cachear).
 */
function shuffleForToday<T>(items: T[], seed: string): T[] {
  const rand = seededRandom(`${new Date().toISOString().substring(0, 10)}:${seed}`);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type RowSort = 'recent' | 'rating' | 'shuffled';

/** Criterios que se traducen a una consulta de Postgres (ver CatalogService.queryRow). */
interface RowQuery {
  type?: 'movie' | 'tvseries';
  genres?: string[];
  subcategory?: string;
  minRating?: number;
  beforeYear?: number;
}

interface RowDefinition {
  id: string;
  title: string;
  subtitle?: string;
  layout: RowLayout;
  sort: RowSort;
  query: RowQuery;
  /** Endpoint de "ver todo" / scroll infinito de la fila. */
  endpoint: string;
}

/**
 * Parrilla del home. Cada definición declara la CONSULTA que la alimenta (se resuelve en
 * Postgres, no filtrando un pool en memoria) y la fila se descarta si no llega a
 * MIN_ROW_ITEMS, de modo que nunca se publica un carrusel a medio llenar.
 * Los títulos son de producto: sin reclamos tipo "100% funcionales".
 */
const ROW_DEFINITIONS: RowDefinition[] = [
  {
    id: 'new_releases',
    title: 'Novedades en el catálogo',
    subtitle: 'Lo último que sumamos, actualizado a diario',
    layout: 'backdrop',
    sort: 'recent',
    query: {},
    endpoint: '/api/v1/discover'
  },
  {
    id: 'movies_spotlight',
    title: 'Películas para ver ahora',
    layout: 'poster',
    sort: 'shuffled',
    query: { type: 'movie' },
    endpoint: '/api/v1/movies'
  },
  {
    id: 'series_spotlight',
    title: 'Series que enganchan desde el primer capítulo',
    layout: 'poster',
    sort: 'shuffled',
    query: { type: 'tvseries' },
    endpoint: '/api/v1/series'
  },
  {
    id: 'top_rated',
    title: 'Aclamadas por la crítica',
    subtitle: 'Las mejor puntuadas del catálogo',
    layout: 'backdrop',
    sort: 'rating',
    query: { minRating: 7.5 },
    endpoint: '/api/v1/discover'
  },
  {
    id: 'anime',
    title: 'Anime en español latino',
    layout: 'poster',
    sort: 'shuffled',
    query: { subcategory: 'Anime' },
    endpoint: '/api/v1/series'
  },
  {
    id: 'action',
    title: 'Acción sin tregua',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Acción', 'Action & Adventure'] },
    endpoint: '/api/v1/discover?genre=Acci%C3%B3n'
  },
  {
    id: 'comedy',
    title: 'Comedias para desconectar',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Comedia'] },
    endpoint: '/api/v1/discover?genre=Comedia'
  },
  {
    id: 'horror',
    title: 'Terror y suspenso',
    subtitle: 'Para ver con la luz apagada',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Terror', 'Misterio', 'Suspense'] },
    endpoint: '/api/v1/discover?genre=Terror'
  },
  {
    id: 'scifi',
    title: 'Ciencia ficción y fantasía',
    layout: 'backdrop',
    sort: 'shuffled',
    query: { genres: ['Ciencia ficción', 'Fantasía', 'Sci-Fi & Fantasy'] },
    endpoint: '/api/v1/discover?genre=Ciencia%20ficci%C3%B3n'
  },
  {
    id: 'family',
    title: 'Animación y cine familiar',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Animación', 'Familia', 'Kids'] },
    endpoint: '/api/v1/discover?genre=Animaci%C3%B3n'
  },
  {
    id: 'drama',
    title: 'Historias que dejan huella',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Drama'] },
    endpoint: '/api/v1/discover?genre=Drama'
  },
  {
    id: 'romance',
    title: 'Romance',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Romance'] },
    endpoint: '/api/v1/discover?genre=Romance'
  },
  {
    id: 'adventure',
    title: 'Aventuras épicas',
    layout: 'backdrop',
    sort: 'shuffled',
    query: { genres: ['Aventura', 'Bélica', 'Western'] },
    endpoint: '/api/v1/discover?genre=Aventura'
  },
  {
    id: 'crime',
    title: 'Crimen e investigación',
    layout: 'poster',
    sort: 'shuffled',
    query: { genres: ['Crimen'] },
    endpoint: '/api/v1/discover?genre=Crimen'
  },
  {
    id: 'documentaries',
    title: 'Documentales',
    layout: 'backdrop',
    sort: 'shuffled',
    query: { genres: ['Documental'] },
    endpoint: '/api/v1/discover?genre=Documental'
  },
  {
    id: 'classics',
    title: 'Clásicos que vale la pena revisitar',
    layout: 'poster',
    sort: 'shuffled',
    query: { beforeYear: 2010, minRating: 6.5 },
    endpoint: '/api/v1/discover'
  }
];

export class FeedService {
  /**
   * Feed de inicio estilo Netflix/Prime: hero rotatorio con ficha completa + ~15 carruseles
   * temáticos construidos sobre un pool ancho del catálogo.
   *
   * Las tarjetas viajan con la metadata completa (sinopsis, logo, duración, clasificación,
   * tráiler…) para que la app pueda abrir su ficha emergente SIN pedir nada más; solo los
   * enlaces de reproducción se resuelven aparte, en /api/v1/media/:id/streams.
   */
  static async getHomeFeed(
    country: string = 'CL',
    opts: { detail?: 'card' | 'compact'; limit?: number; rows?: string[] } = {}
  ): Promise<HomeFeedResponse> {
    const cc = (country || 'CL').toUpperCase();
    const detail = opts.detail === 'compact' ? 'compact' : 'card';
    const perRow = Math.max(5, Math.min(opts.limit || 20, 40));

    const cacheKey = `home:${cc}:${detail}:${perRow}`;
    let feed = await CacheStore.get<HomeFeedResponse>(cacheKey);

    if (!feed) {
      feed = await this.buildHomeFeed(cc, detail, perRow);
      await CacheStore.set(cacheKey, feed, HOME_TTL_SECONDS);
    }

    // El filtro por filas se aplica sobre el feed cacheado: pedir un subconjunto no
    // obliga a reconstruir nada.
    if (opts.rows && opts.rows.length > 0) {
      const wanted = new Set(opts.rows.map(r => r.trim().toLowerCase()).filter(Boolean));
      return { ...feed, rows: feed.rows.filter(row => wanted.has(row.id.toLowerCase())) };
    }

    return feed;
  }

  private static async buildHomeFeed(
    cc: string,
    detail: 'card' | 'compact',
    perRow: number
  ): Promise<HomeFeedResponse> {
    const project = detail === 'compact'
      ? (item: MediaItem) => CatalogService.toCompactItem(item)
      : (item: MediaItem) => CatalogService.toCardItem(item);

    // Cada carrusel pide SUS candidatos a Postgres; todas las consultas van en paralelo.
    // Se piden más de los que se muestran para poder barajar a diario y descartar repetidos.
    const CANDIDATES_PER_ROW = 80;
    const [recent, ...rowCandidates] = await Promise.all([
      CatalogService.queryRow({ order: 'recent', limit: 200 }),
      ...ROW_DEFINITIONS.map(def =>
        CatalogService.queryRow({
          ...def.query,
          order: def.sort === 'recent' ? 'recent' : 'rating',
          limit: CANDIDATES_PER_ROW
        })
      )
    ]);

    if (recent.length === 0 && rowCandidates.every(c => c.length === 0)) {
      return { featured: null, spotlight: [], rows: [], updated_at: new Date().toISOString() };
    }

    // ── Hero: títulos con imagen ancha y sinopsis real, rotados a diario ─────────────
    const heroPool = this.dedupe([...recent, ...rowCandidates.flat()])
      .filter(item => item.backdrop && hasRealOverview(item))
      .sort((a, b) => {
        // El arte tipográfico (logo) es lo que da el acabado de portada.
        const logoDelta = (b.logo ? 1 : 0) - (a.logo ? 1 : 0);
        if (logoDelta !== 0) return logoDelta;
        return (b.rating || 0) - (a.rating || 0);
      })
      .slice(0, 60);

    const spotlightItems = await this.completeHeroMetadata(shuffleForToday(heroPool, 'spotlight').slice(0, 5));
    const spotlight = spotlightItems.map(item => CatalogService.toHeroItem(item));

    // ── Top 10 del país: lo mejor valorado de entre lo más reciente ──────────────────
    const top10 = [...recent]
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 10);

    const rows: HomeFeedRow[] = [];
    if (top10.length >= MIN_ROW_ITEMS) {
      rows.push({
        id: `top_10_${cc.toLowerCase()}`,
        title: `Top 10 en ${COUNTRY_NAMES[cc] || cc} hoy`,
        subtitle: 'Lo que más se está viendo',
        type: 'carousel',
        layout: 'ranked',
        items: top10.map(project),
        endpoint: '/api/v1/discover'
      });
    }

    // ── Carruseles temáticos ────────────────────────────────────────────────────────
    // usage evita que el mismo título aparezca en todas las filas; si una fila no llega
    // al mínimo con títulos "frescos", se completa reutilizando (mejor repetir que
    // publicar un carrusel a medias).
    const usage = new Map<string, number>();
    const countUse = (item: MediaItem) => usage.set(item.id, (usage.get(item.id) || 0) + 1);

    ROW_DEFINITIONS.forEach((def, index) => {
      const candidates = rowCandidates[index] || [];
      if (candidates.length < MIN_ROW_ITEMS) return;

      const ordered = this.sortRow(candidates, def);
      const fresh = ordered.filter(item => (usage.get(item.id) || 0) < MAX_ROW_REPEATS);
      const picked = (fresh.length >= MIN_ROW_ITEMS ? fresh : ordered).slice(0, perRow);
      if (picked.length < MIN_ROW_ITEMS) return;

      picked.forEach(countUse);
      rows.push({
        id: def.id,
        title: def.title,
        subtitle: def.subtitle,
        type: 'carousel',
        layout: def.layout,
        items: picked.map(project),
        endpoint: def.endpoint
      });
    });

    return {
      featured: spotlight[0] || null,
      spotlight,
      rows,
      updated_at: new Date().toISOString()
    };
  }

  private static dedupe(items: MediaItem[]): MediaItem[] {
    const seen = new Set<string>();
    return items.filter(item => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  /**
   * El hero es lo primero que se ve, así que no puede salir sin logo, duración ni
   * clasificación. Si la ficha guardada no los trae (títulos crawleados antes del último
   * refresco), se completan contra TMDB solo para estos 5. Va dentro del feed cacheado:
   * son ~5 llamadas cada 10 minutos, y un fallo o una demora nunca degradan el home.
   */
  private static async completeHeroMetadata(items: MediaItem[]): Promise<MediaItem[]> {
    const needsCompletion = (item: MediaItem) => !item.logo || !item.runtime || !item.content_rating;

    return Promise.all(items.map(async item => {
      if (!needsCompletion(item)) return item;
      const timeout = new Promise<MediaItem>(resolve => setTimeout(() => resolve(item), 3000));
      try {
        return await Promise.race([TmdbService.enrichMediaItem(item, { skipSeasons: true }), timeout]);
      } catch {
        return item;
      }
    }));
  }

  private static sortRow(items: MediaItem[], def: RowDefinition): MediaItem[] {
    switch (def.sort) {
      case 'rating':
        return [...items].sort((a, b) => (b.rating || 0) - (a.rating || 0));
      case 'shuffled':
        // Barajado del día sobre los mejor valorados: variedad sin sacar relleno.
        return shuffleForToday(
          [...items].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 120),
          def.id
        );
      case 'recent':
      default:
        // El pool ya viene ordenado por frescura (updated_at desc).
        return items;
    }
  }

  /**
   * Paginación infinita (Infinite Scroll). DB-FIRST: el filtrado y el corte los hace
   * Postgres, así que el "ver todo" de una fila recorre el catálogo COMPLETO y no las
   * primeras filas cargadas en memoria. Cae al filtrado en memoria si la DB está vacía.
   */
  static async getDiscover(page: number = 1, limit: number = 20, type?: string, genre?: string) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, Math.min(limit, 100));

    const fromDb = await CatalogService.discoverPaged(safePage, safeLimit, type, genre);
    if (fromDb) {
      const consumed = (safePage - 1) * safeLimit + fromDb.items.length;
      const hasMore = consumed < fromDb.total;
      return {
        page: safePage,
        limit: safeLimit,
        total_results: fromDb.total,
        has_more: hasMore,
        next_page: hasMore ? safePage + 1 : null,
        results: fromDb.items.map(item => CatalogService.toPublicItem(item))
      };
    }

    let items = await CatalogService.getAll();

    if (type) {
      items = items.filter(i => i.type === type);
    }
    if (genre) {
      items = items.filter(i => i.genres.some(g => norm(g).includes(norm(genre))));
    }

    const startIndex = (safePage - 1) * safeLimit;
    const paginatedItems = items.slice(startIndex, startIndex + safeLimit);
    const hasMore = startIndex + safeLimit < items.length;

    return {
      page: safePage,
      limit: safeLimit,
      total_results: items.length,
      has_more: hasMore,
      next_page: hasMore ? safePage + 1 : null,
      results: paginatedItems.map(item => CatalogService.toPublicItem(item))
    };
  }
}
