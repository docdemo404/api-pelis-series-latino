import 'dotenv/config';
import { TmdbService } from '../../src/services/tmdbService';
import { supabase } from '../../src/services/supabaseService';
import { ContentType } from '../../src/types';

/**
 * Estima cuántas de las fichas SIN match en TMDB (tmdb_id sintético negativo) recupera el
 * matcher corregido. Trabaja sobre una muestra para dar una cifra en minutos, no en horas.
 */
const SAMPLE = Number(process.argv[2] || 120);

(async () => {
  const { data, count } = await supabase
    .from('media_items')
    .select('id,tmdb_id,type,title,release_date', { count: 'exact' })
    .lt('tmdb_id', 0)
    .limit(SAMPLE);

  const rows = data || [];
  console.log(`Fichas sintéticas en el catálogo: ${count}  ·  muestra analizada: ${rows.length}\n`);

  let matched = 0;
  let collides = 0;
  const examples: string[] = [];

  const CONCURRENCY = 5;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async r => {
      const type: ContentType = r.type === 'tvseries' ? 'tvseries' : 'movie';
      const year = String(r.release_date || '').slice(0, 4) || undefined;
      try {
        return { r, m: await TmdbService.resolveTmdb(r.title, type, year, r.id) };
      } catch {
        return { r, m: null };
      }
    }));

    for (const { r, m } of results) {
      if (!m || !m.matched || m.id <= 0) continue;
      matched++;
      // ¿El tmdb_id real ya lo ocupa otra fila? Entonces esta ficha es un DUPLICADO que
      // hasta ahora vivía como entidad independiente.
      const { data: clash } = await supabase
        .from('media_items').select('id,title').eq('tmdb_id', m.id).limit(1);
      if (clash && clash.length > 0) {
        collides++;
        if (examples.length < 12) examples.push(`   "${r.title}" (${r.id})\n      = "${clash[0].title}" (${clash[0].id})  tmdb ${m.id}`);
      }
    }
  }

  const pct = (n: number) => ((n / (rows.length || 1)) * 100).toFixed(1);
  console.log(`Ahora emparejan con TMDB      ${matched}/${rows.length}  (${pct(matched)}%)`);
  console.log(`   de ellas, DUPLICADOS de una ficha ya existente  ${collides}  (${pct(collides)}%)`);
  console.log(`\nProyección sobre las ${count} sintéticas: ~${Math.round((matched / (rows.length || 1)) * (count || 0))} recuperadas, ` +
    `~${Math.round((collides / (rows.length || 1)) * (count || 0))} eran duplicados\n`);
  console.log('Duplicados detectados en la muestra:');
  examples.forEach(e => console.log(e));
})();
