/**
 * Spot-check del emparejado con TMDB para los casos difíciles (homónimos de otra época,
 * títulos regionales que no calcan en es-MX). NO toca la base: solo resuelve e imprime la
 * ficha elegida (id, título, año, score). Útil para verificar el arreglo antes de reparar.
 *
 *   ts-node scripts/dev/diag_match.ts
 */
import 'dotenv/config';
import { TmdbService } from '../../src/services/tmdbService';
import { ContentType } from '../../src/types';

interface Case {
  title: string;
  type?: ContentType;
  year?: string;
  originalTitle?: string;
  imageHint?: string;
  expect: string;
}

const CASES: Case[] = [
  { title: 'El fundador', year: '2016', originalTitle: 'The Founder',
    expect: 'The Founder / "Hambre de poder" (2016), id 310307 — NO "Bonifácio - O Fundador do Brasil" (2018)' },
  { title: 'El fundador', year: '2016', originalTitle: 'The Founder',
    imageHint: 'https://image.tmdb.org/t/p/w1280/5WparwIlAtSZW0tcWbK2NHEZJC6.jpg',
    expect: 'confirmado por imagen → score 1.0' },
  { title: 'El fundador', year: '2016',
    expect: 'sin título original: al menos NO debe fijar Bonifácio (2018)' },
  { title: 'Heidi', year: '2015',
    expect: 'Heidi (2015), no otra Heidi' },
  { title: 'Solo en casa', year: '1990', originalTitle: 'Home Alone',
    expect: 'Home Alone (1990) — NO "Gambling House" (regresión)' },
  { title: 'Vengadores: La era de Ultrón', year: '2015', originalTitle: 'Avengers: Age of Ultron',
    expect: 'Avengers: Age of Ultron (2015) (regresión)' },
];

(async () => {
  for (const c of CASES) {
    const type: ContentType = c.type || 'movie';
    const match = await TmdbService.resolveTmdb(c.title, type, c.year, `diag:${c.title}:${c.year || ''}`, {
      originalTitle: c.originalTitle,
      imageHint: c.imageHint
    });

    let label = '(sin match fiable → fallback a metadata de la fuente)';
    let resolvedYear = '';
    if (match.matched && match.id > 0) {
      const d = await TmdbService.getTmdbDetails(match.id, type).catch(() => null);
      label = d ? (d.title || d.name || String(match.id)) : String(match.id);
      resolvedYear = d ? String(d.release_date || d.first_air_date || '').slice(0, 4) : '';
    }

    const head = `"${c.title}"`
      + (c.originalTitle ? ` / orig "${c.originalTitle}"` : '')
      + (c.year ? ` (${c.year})` : '')
      + (c.imageHint ? ' [+imagen]' : '');
    console.log(`\n${head}`);
    console.log(`   → tmdb ${match.id}  "${label}"${resolvedYear ? ` (${resolvedYear})` : ''}  score ${match.score.toFixed(2)}`);
    console.log(`   esperado: ${c.expect}`);
  }
  process.exit(0);
})();
