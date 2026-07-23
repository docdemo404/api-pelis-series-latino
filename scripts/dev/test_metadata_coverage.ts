/**
 * Comprueba la resolución contra TMDB y el fallback a metadata de la fuente.
 *   npx ts-node scripts/dev/test_metadata_coverage.ts
 */
import 'dotenv/config';
import { TmdbService } from '../../src/services/tmdbService';
import { MediaItem } from '../../src/types';

const samples: Array<{ title: string; type: 'movie' | 'tvseries'; year?: string }> = [
  { title: 'Ver Matilda online gratis HD Latino', type: 'movie' },
  { title: 'Gru 3 Mi Villano Favorito (2017)', type: 'movie', year: '2017' },
  { title: 'Breaking Bad', type: 'tvseries' },
  { title: 'One Piece Temporada 21', type: 'tvseries' },
  { title: 'Pelicula Random Inventada Zzzz 9999', type: 'movie' }
];

function stub(s: { title: string; type: 'movie' | 'tvseries'; year?: string }): MediaItem {
  return {
    id: s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    tmdb_id: 0, imdb_id: null, type: s.type,
    title: s.title, original_title: s.title, aliases: [s.title],
    overview: '', rating: 0, release_date: s.year || '',
    genres: [], subcategories: [], poster: 'https://cdn.fuente/poster.jpg',
    backdrop: null, logo: null, trailer: null, cast: [], dubbing_cast: []
  };
}

async function main() {
  for (const s of samples) {
    const match = await TmdbService.resolveTmdb(s.title, s.type, s.year, s.title);
    const item = await TmdbService.enrichMediaItem(stub(s), { skipSeasons: true });
    console.log(
      `${match.matched ? '✔ TMDB' : '↩ fuente'} score=${match.score.toFixed(2)} id=${match.id}\n` +
      `   "${s.title}" → "${item.title}" | poster=${item.poster ? 'sí' : 'NO'} | ` +
      `overview=${item.overview ? 'sí' : 'NO'} | src=${item.metadata_source}`
    );
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
