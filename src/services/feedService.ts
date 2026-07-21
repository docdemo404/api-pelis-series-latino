import { HomeFeedResponse } from '../types';
import { CatalogService } from './catalogService';

export class FeedService {
  /**
   * Genera las filas horizontales y carruseles para la pantalla de inicio estilo Netflix
   */
  static async getHomeFeed(country: string = 'CL'): Promise<HomeFeedResponse> {
    const all = await CatalogService.getAll();
    const featured = all.find(i => i.backdrop) || all[0] || null;

    const trendingChile = all.slice(0, 10).map(CatalogService.toCompactItem as any);
    const popularSeries = all.filter(i => i.type === 'tvseries').slice(0, 10).map(CatalogService.toCompactItem as any);
    const recentMovies = all.filter(i => i.type === 'movie').slice(0, 10).map(CatalogService.toCompactItem as any);

    return {
      featured: featured ? (CatalogService.toCompactItem(featured) as any) : null,
      rows: [
        {
          id: `trending_${country.toLowerCase()}`,
          title: `Lo más popular en ${country.toUpperCase()} hoy`,
          type: 'carousel',
          items: trendingChile as any
        },
        {
          id: 'popular_series',
          title: 'Series aclamadas en Español Latino',
          type: 'carousel',
          items: popularSeries as any
        },
        {
          id: 'recent_movies',
          title: 'Películas agregadas recientemente (100% Funcionales)',
          type: 'carousel',
          items: recentMovies as any
        }
      ]
    };
  }

  /**
   * Paginación infinita (Infinite Scroll)
   */
  static async getDiscover(page: number = 1, limit: number = 20, type?: string, genre?: string) {
    let items = await CatalogService.getAll();

    if (type) {
      items = items.filter(i => i.type === type);
    }
    if (genre) {
      items = items.filter(i => i.genres.some(g => g.toLowerCase().includes(genre.toLowerCase())));
    }

    const startIndex = (page - 1) * limit;
    const paginatedItems = items.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < items.length;

    return {
      page,
      limit,
      total_results: items.length,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
      results: paginatedItems
    };
  }
}
