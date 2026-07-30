/**
 * ¿Puede una ficha adoptar servidores de OTRA película que solo comparte el título?
 *
 * La fusión multifuente busca candidatos por el título de la ficha, y ese título es el de TMDB
 * en español: el que más colisiona. Este diagnóstico repite esa búsqueda en vivo y enseña, para
 * cada candidato, qué contesta la puerta de identidad de `catalogService` (`mismaObra`):
 *
 *   misma       → hay prueba (mismo tmdb_id real, o mismo tipo + título + año ±1): se adopta.
 *   distinta    → hay prueba de que es otra obra: se descarta.
 *   sin-pruebas → homónimo sin año: se descarta igual, pero la ficha NO se marca como fantasma.
 *
 * Además compara con el criterio ANTERIOR —solo el título—, que es el que mezclaba: la columna
 * `antes` marca los candidatos que se adoptaban y ahora no.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_homonimos.ts            # casos conocidos
 *   npx ts-node --transpile-only scripts/dev/diag_homonimos.ts "Carrie"   # un título concreto
 */
import 'dotenv/config';
import { MediaItem } from '../../src/types';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { RealScraperService } from '../../src/services/realScraperService';
import { mismaObra, yearOf } from '../../src/services/catalogService';
import { normalizeTitle } from '../../src/utils/text';

const db = getSupabaseAdmin();

/** Títulos con homónimos comprobados en las fuentes (remakes y coincidencias de doblaje). */
const CASOS = ['Sin salida', 'Carrie', 'Drácula', 'Las Brujas', 'La Cacería'];

/** El criterio de antes: mismo título (alfanumérico, sin acentos) y nada más. */
function soloPorTitulo(a: string, b: string): boolean {
  const k = (t: string) => normalizeTitle(t).replace(/[^a-z0-9]/g, '');
  return !!k(a) && k(a) === k(b);
}

async function fichasCon(titulo: string): Promise<MediaItem[]> {
  const { data } = await db
    .from('media_items')
    .select('id,tmdb_id,type,title,original_title,release_date,source_url,source_urls')
    .ilike('title', titulo);
  return (data || []).map((r: any) => ({ ...r, _source_url: r.source_url })) as MediaItem[];
}

(async () => {
  const titulos = process.argv.slice(2).length ? process.argv.slice(2) : CASOS;
  let mezclasEvitadas = 0;

  for (const titulo of titulos) {
    const fichas = await fichasCon(titulo);
    const candidatos = await RealScraperService.scrapeRealMovies(titulo, 8).catch(() => [] as MediaItem[]);

    console.log(`\n════ "${titulo}" — ${fichas.length} ficha(s) en la DB, ${candidatos.length} candidato(s) en las fuentes`);
    if (fichas.length === 0) {
      console.log('   (ninguna ficha guardada con ese título exacto)');
      continue;
    }

    for (const ficha of fichas) {
      console.log(`\n  ▸ ficha ${ficha.id}  tmdb=${ficha.tmdb_id}  año=${yearOf(ficha) || '?'}  [${ficha.type}]`);
      for (const cand of candidatos) {
        const veredicto = mismaObra(ficha, cand);
        const antes = soloPorTitulo(ficha.title, cand.title);
        // Lo que este arreglo evita: se adoptaba y no era la misma obra.
        const evitado = antes && veredicto !== 'misma';
        if (evitado) mezclasEvitadas++;
        // Solo interesa lo que alguno de los dos criterios habría adoptado.
        if (!antes && veredicto !== 'misma') continue;
        const marca = veredicto === 'misma' ? '✓ adopta' : evitado ? '✗ EVITADO' : '· ignora';
        console.log(
          `      ${marca.padEnd(10)} ${veredicto.padEnd(11)} "${cand.title}" (${yearOf(cand) || '?'}) [${cand.type}]` +
          `\n                                 ${(cand as any)._tioplus_url || cand.id}`
        );
      }
    }
  }

  console.log(`\n${mezclasEvitadas === 0 ? '✅' : '🛑'} adopciones que el criterio viejo permitía y este bloquea: ${mezclasEvitadas}`);
})();
