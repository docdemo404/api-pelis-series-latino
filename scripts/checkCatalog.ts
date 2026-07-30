/**
 * Diagnóstico del estado real del catálogo en Supabase.
 *
 *   npm run check:catalog
 *   npm run check:catalog -- --fallar-si-hay-cruces   # sale con error si hay contenido cruzado
 *   npm run check:catalog -- --muestra=0              # sin el muestreo de carátulas (más rápido)
 *
 * Responde de un vistazo a "¿se aplicaron las migraciones?" y "¿llegó a correr el crawl?",
 * que son las dos cosas de las que depende que la ficha emergente abra al instante, y a la que
 * no puede fallar nunca: "¿cada película y cada serie tiene SU contenido, SU carátula y SU
 * sinopsis, y no las de otra?".
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { candidateIdsForUrl } from '../src/services/catalogService';
import { TmdbService, tmdbImagePath } from '../src/services/tmdbService';
import { RealScraperService } from '../src/services/realScraperService';
import { ContentType } from '../src/types';

const db = getSupabaseAdmin();

const NEW_COLUMNS = ['metadata_source', 'servers', 'seasons', 'source_url', 'runtime', 'director', 'streams_updated_at'];

/** ¿Existe la columna? (una consulta que falla con 42703 si no) */
async function columnExists(column: string): Promise<boolean> {
  const { error } = await db.from('media_items').select(column).limit(1);
  return !error;
}

/** Nº de filas que cumplen un filtro, sin traerse los datos. */
async function countWhere(apply: (q: any) => any): Promise<number> {
  const { count, error } = await apply(db.from('media_items').select('id', { count: 'exact', head: true }));
  if (error) return -1;
  return count ?? 0;
}

/**
 * AUDITORÍA DE CONTENIDO CRUZADO — ¿alguna ficha saca servidores de la página de otra?
 *
 * `source_urls` dice de qué páginas sale el vídeo de una ficha. Que ahí aparezca la página de
 * OTRA ficha del catálogo es prueba definitiva de contaminación, y se comprueba sin salir a la
 * red: el id de cada fila ES el slug de su propia página de origen, así que basta preguntar quién
 * es el dueño de cada url y ver si es alguien con otro tmdb_id.
 *
 * Es la invariante que no debe romperse nunca: toda película y serie sirve SU contenido. Si esto
 * devuelve algo, hay una vía de fusión sin comprobar el año → `repair:catalog --fuentes` lo
 * limpia, pero además hay que encontrar por dónde entró.
 */
async function auditCrossedContent(): Promise<{ cruzadas: number; ejemplos: string[] }> {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,release_date,source_url,source_urls')
      .range(from, from + PAGE - 1);
    if (error) return { cruzadas: -1, ejemplos: [`no se pudo leer: ${error.message}`] };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const byId = new Map<string, any>(rows.map(r => [String(r.id), r]));

  // Los moldes con los que cada fuente forma el id de su fila viven en catalogService, para que
  // la auditoría y las purgas no puedan discrepar sobre quién es el dueño de una página.
  const ownerOf = (url: string): any =>
    candidateIdsForUrl(url).map(c => byId.get(c)).find(Boolean);

  let cruzadas = 0;
  const ejemplos: string[] = [];

  for (const row of rows) {
    for (const url of (row.source_urls || []).filter(Boolean) as string[]) {
      const owner = ownerOf(url);
      if (!owner || owner.id === row.id) continue;
      // Dos filas distintas con el MISMO tmdb_id real son la misma obra duplicada (pendiente de
      // fundir), no contenido cruzado.
      if (!(owner.tmdb_id > 0) || !(row.tmdb_id > 0) || owner.tmdb_id === row.tmdb_id) continue;
      cruzadas++;
      if (ejemplos.length < 10) {
        ejemplos.push(
          `"${row.title}" (${String(row.release_date || '').slice(0, 4) || '?'}, tmdb ${row.tmdb_id})` +
          ` saca vídeo de la página de "${owner.title}" (${String(owner.release_date || '').slice(0, 4) || '?'}, tmdb ${owner.tmdb_id})\n        ${url}`
        );
      }
    }
  }

  return { cruzadas, ejemplos };
}

/**
 * MUESTREO DE CARÁTULAS Y SINOPSIS — ¿la metadata de cada ficha es de la película que dice ser?
 *
 * El `tmdb_id` de una fila no lo publica la fuente: lo DEDUCE el matcher a partir del título, y
 * cuando acierta de menos la ficha se queda con el póster, la sinopsis y el reparto de otra
 * película ("Atomica" de 2017 son dos películas distintas, y una se llevaba la carátula de la
 * otra). No hay forma de detectarlo sin salir a la red, porque una vez escrita la fila es
 * coherente consigo misma: hay que preguntarle a su página de origen.
 *
 * Así que aquí se ESTIMA con una muestra pequeña, para que el número esté a la vista. Quien de
 * verdad repasa y corrige el catálogo entero es `repair:catalog --verify`, que corre solo cada día
 * sobre una tanda rotatoria. Las dos comprobaciones son la misma: el `og:image` de la página
 * apunta a una ficha concreta de TMDB, y si no lo trae se re-resuelve con todo lo que publique.
 */
async function sampleMetadataMismatch(n: number): Promise<{ revisadas: number; malas: number; ejemplos: string[] }> {
  const { data } = await db
    .from('media_items')
    .select('id,tmdb_id,type,title,release_date,source_url,source_urls')
    .eq('metadata_source', 'tmdb')
    .gt('tmdb_id', 0)
    .limit(2000);

  const pool = (data || []).sort(() => Math.random() - 0.5).slice(0, n);
  let revisadas = 0;
  let malas = 0;
  const ejemplos: string[] = [];

  const CONC = 5;
  for (let i = 0; i < pool.length; i += CONC) {
    await Promise.all(pool.slice(i, i + CONC).map(async (r: any) => {
      const url = r.source_url || (r.source_urls || [])[0];
      if (!url) return;
      const s = await RealScraperService.fetchSourceSignals(url).catch(() => null);
      if (!s || !s.title) return;
      const type: ContentType = r.type === 'tvseries' ? 'tvseries' : 'movie';

      // Etapa 1 — el og:image confirma la ficha guardada: no hay nada que revisar.
      const img = tmdbImagePath(s.imageHint);
      if (img) {
        const stored = await TmdbService.getTmdbDetails(r.tmdb_id, type).catch(() => null);
        if (stored && (img === tmdbImagePath(stored.poster_path) || img === tmdbImagePath(stored.backdrop_path))) {
          revisadas++;
          return;
        }
      }

      // Etapa 2 — re-resolver con todo lo que publica la página. Solo cuenta como error si el
      // resultado viene RESPALDADO: una sospecha sin respaldo no es prueba de nada.
      const m = await TmdbService.resolveTmdb(s.title, type, s.year || undefined, r.id, {
        originalTitle: s.originalTitle || null,
        imageHint: s.imageHint || null,
        episodeHint: s.episode || null
      }).catch(() => null);
      revisadas++;
      if (!m || !m.matched || !m.verified || m.id === r.tmdb_id) return;

      malas++;
      if (ejemplos.length < 5) {
        ejemplos.push(`${r.id} — guardado "${r.title}" (tmdb ${r.tmdb_id}); su página dice "${s.title}" (${s.year || '?'}) = tmdb ${m.id}`);
      }
    }));
  }

  return { revisadas, malas, ejemplos };
}

/** Frase de relleno de la fuente: "Ver <título> online gratis en HD con audio Latino". */
const SINOPSIS_DE_RELLENO = /^Ver .* online (gratis )?(en |con )/i;

/**
 * PASO 5 · Una ficha que adoptó TMDB no puede quedarse SIN lo que TMDB tiene.
 *
 * Nació de "Max Is Missing": tenía póster, título y tmdb_id de TMDB, y de sinopsis el relleno de
 * la fuente —"Ver Max ha desaparecido online gratis en HD con audio Latino"—, que no cuenta nada
 * de la película. TMDB la tenía vacía en español y escrita en inglés, y el código se rendía antes
 * de mirar sus traducciones. Eran 174 fichas y nadie lo habría visto: la ficha parecía completa.
 *
 * NO USA UMBRALES, y es lo que la hace utilizable a diario. Encuentra las fichas a las que les
 * falta algo, le PREGUNTA a TMDB si él lo tiene, y solo cuenta las que sí. Así una película cuya
 * sinopsis TMDB tampoco conoce no deja la corrida en rojo para siempre —no hay nada que
 * arreglar— y cualquier hueco que sí se pueda rellenar sale como error desde la primera vez.
 *
 * Es barata porque el conjunto es pequeño por construcción: si crece, es justo la señal que
 * interesa. Se acota de todas formas, para que un fallo masivo no dispare miles de peticiones.
 */
async function auditMissingMetadata(): Promise<{ reparables: number; sinRemedio: number; ejemplos: string[] }> {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from('media_items')
      .select('id,title,type,tmdb_id,overview,poster,release_date')
      .gt('tmdb_id', 0)
      .range(from, from + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  const huecos = filas
    .map(f => ({
      f,
      falta: [
        SINOPSIS_DE_RELLENO.test(String(f.overview || '')) || !String(f.overview || '').trim() ? 'sinopsis' : '',
        !String(f.release_date || '').trim() ? 'fecha' : '',
        f.poster && !/image\.tmdb\.org|themoviedb\.org/i.test(String(f.poster)) ? 'póster' : '',
      ].filter(Boolean),
    }))
    .filter(x => x.falta.length > 0)
    .slice(0, 300);

  let reparables = 0;
  let sinRemedio = 0;
  const ejemplos: string[] = [];

  const CONC = 5;
  for (let i = 0; i < huecos.length; i += CONC) {
    await Promise.all(huecos.slice(i, i + CONC).map(async ({ f, falta }) => {
      const type: ContentType = f.type === 'tvseries' ? 'tvseries' : 'movie';
      const d = await TmdbService.getTmdbDetails(f.tmdb_id, type).catch(() => null);
      if (!d) { sinRemedio++; return; }

      const tmdbLoTiene = falta.filter(q =>
        (q === 'sinopsis' && String(d.overview || '').trim() && !SINOPSIS_DE_RELLENO.test(String(d.overview))) ||
        (q === 'fecha' && String(d.release_date || d.first_air_date || '').trim()) ||
        (q === 'póster' && d.poster_path)
      );

      if (tmdbLoTiene.length === 0) { sinRemedio++; return; }
      reparables++;
      if (ejemplos.length < 6) {
        ejemplos.push(`${f.id} — "${String(f.title).slice(0, 34)}" (tmdb ${f.tmdb_id}): le falta ${tmdbLoTiene.join(', ')} y TMDB sí la tiene`);
      }
    }));
  }

  return { reparables, sinRemedio, ejemplos };
}

function bar(done: number, total: number): string {
  if (total <= 0) return '';
  const pct = Math.round((done / total) * 100);
  const filled = Math.round(pct / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

async function main() {
  console.log('\n══ Estado del catálogo ══\n');

  // ── Paso 1: migraciones ────────────────────────────────────────────────────
  const present = await Promise.all(NEW_COLUMNS.map(async c => [c, await columnExists(c)] as const));
  const missing = present.filter(([, ok]) => !ok).map(([c]) => c);

  console.log('PASO 1 · Migraciones (columnas nuevas)');
  for (const [column, ok] of present) console.log(`   ${ok ? '✅' : '❌'} ${column}`);
  if (missing.length > 0) {
    console.log(`\n   ⚠ Faltan ${missing.length} columnas → ejecuta src/db/migrations/EJECUTAR_EN_SUPABASE.sql`);
    console.log('     en el SQL Editor de Supabase. Sin ellas el paso 2 no puede guardar nada.\n');
    return;
  }
  console.log('   → El SQL se aplicó correctamente.\n');

  // ── Paso 2: crawl ──────────────────────────────────────────────────────────
  const total = await countWhere(q => q);
  const withSourceUrl = await countWhere(q => q.not('source_url', 'is', null));
  const withRuntime = await countWhere(q => q.not('runtime', 'is', null));
  const withLogo = await countWhere(q => q.not('logo', 'is', null));
  const withStreams = await countWhere(q => q.not('streams_updated_at', 'is', null));
  const anime = await countWhere(q => q.contains('subcategories', ['Anime']));

  const { data: newest } = await db.from('media_items').select('updated_at').order('updated_at', { ascending: false }).limit(1);
  const lastUpdate = newest && newest[0] ? new Date(newest[0].updated_at) : null;
  const hoursAgo = lastUpdate ? (Date.now() - lastUpdate.getTime()) / 3600000 : Infinity;

  console.log('PASO 2 · Crawl (npm run refresh:catalog -- --streams=300)');
  console.log(`   Fichas en el catálogo:      ${total}`);
  console.log(`   Última actualización:       ${lastUpdate ? `${lastUpdate.toLocaleString()} (hace ${hoursAgo.toFixed(1)} h)` : 'nunca'}`);
  console.log(`   Con URL de la fuente:       ${withSourceUrl}/${total}  ${bar(withSourceUrl, total)}`);
  console.log(`   Con enlaces ya resueltos:   ${withStreams}/${total}  ${bar(withStreams, total)}`);
  console.log(`   Con duración (runtime):     ${withRuntime}/${total}  ${bar(withRuntime, total)}`);
  console.log(`   Con logo para el hero:      ${withLogo}/${total}  ${bar(withLogo, total)}`);
  console.log(`   Etiquetadas como anime:     ${anime}`);

  // ── Paso 3: contenido cruzado ──────────────────────────────────────────────
  const cruce = await auditCrossedContent();
  console.log('\nPASO 3 · Cada ficha sirve SU contenido');
  if (cruce.cruzadas < 0) {
    console.log(`   ⚠ ${cruce.ejemplos[0]}`);
  } else if (cruce.cruzadas === 0) {
    console.log('   ✅ Ninguna ficha saca vídeo de la página de otra.');
  } else {
    console.log(`   ❌ ${cruce.cruzadas} fuente(s) pertenecen a OTRA ficha del catálogo:`);
    for (const e of cruce.ejemplos) console.log(`      · ${e}`);
    console.log('\n      Límpialo con:  npm run repair:catalog -- --fuentes --apply');
    console.log('      Y averigua por dónde entró: alguna fusión está emparejando sin comprobar el año.');
  }

  // ── Paso 4: carátulas y sinopsis (muestreo) ────────────────────────────────
  const muestraFlag = process.argv.find(a => a.startsWith('--muestra'));
  const nMuestra = muestraFlag
    ? (muestraFlag.includes('=') ? parseInt(muestraFlag.split('=')[1], 10) : 25)
    : 25;
  if (Number.isFinite(nMuestra) && nMuestra > 0) {
    console.log('\nPASO 4 · Cada ficha tiene SU carátula y SU sinopsis (muestreo)');
    const m = await sampleMetadataMismatch(nMuestra);
    if (m.revisadas === 0) {
      console.log('   ⚠ no se pudo comprobar ninguna (¿las fuentes no responden?)');
    } else if (m.malas === 0) {
      console.log(`   ✅ ${m.revisadas}/${m.revisadas} de la muestra concuerdan con su página de origen.`);
    } else {
      const pct = (m.malas / m.revisadas) * 100;
      console.log(`   ⚠ ${m.malas}/${m.revisadas} de la muestra tienen metadata de otra película (≈${pct.toFixed(1)}% del catálogo):`);
      for (const e of m.ejemplos) console.log(`      · ${e}`);
      console.log('\n      Corrígelo con:  npm run repair:catalog -- --verify --apply');
    }
  }

  // ── Paso 5: nada que TMDB tenga puede faltar en una ficha que lo adoptó ─────
  console.log('\nPASO 5 · Ninguna ficha adoptada se queda sin lo que TMDB sí tiene');
  const huecos = await auditMissingMetadata();
  if (huecos.reparables === 0) {
    console.log(`   ✅ Sin huecos rellenables${huecos.sinRemedio ? ` (${huecos.sinRemedio} que TMDB tampoco tiene)` : ''}.`);
  } else {
    console.log(`   ⚠ ${huecos.reparables} fichas a las que les falta algo que TMDB SÍ publica:`);
    for (const e of huecos.ejemplos) console.log(`      · ${e}`);
    console.log('\n      Rellénalo con:  npm run repair:catalog -- --sinopsis --apply');
  }

  // Con --fallar-si-hay-cruces el script sale con código 1: es lo que pone en rojo la corrida
  // diaria del workflow si alguna vía de fusión vuelve a mezclar películas, o si una ficha se
  // queda sin metadata que estaba a una petición de distancia.
  const roto = cruce.cruzadas > 0 || huecos.reparables > 0;
  if (roto && process.argv.includes('--fallar-si-hay-cruces')) {
    if (cruce.cruzadas > 0) console.log('\n❌ La invariante está rota: hay fichas sirviendo contenido de otras.');
    if (huecos.reparables > 0) console.log('❌ Hay fichas sin metadata que TMDB publica y nadie fue a buscar.');
    console.log('');
    process.exit(1);
  }

  console.log('\n══ Veredicto ══\n');
  if (withSourceUrl === 0) {
    console.log('   ❌ El crawl NO ha corrido (o corrió antes de aplicar el SQL).');
    console.log('      Ninguna ficha tiene source_url, así que abrir una y darle a Reproducir');
    console.log('      sigue costando segundos de scraping.\n');
    console.log('      Ejecuta:  npm run refresh:catalog -- --streams=300');
    console.log('      (o lanza el workflow "Catalog Refresh" desde la pestaña Actions de GitHub)\n');
  } else if (withSourceUrl < total * 0.5) {
    console.log(`   ⚠ El crawl corrió a medias: solo ${Math.round((withSourceUrl / total) * 100)}% de las fichas tienen source_url.`);
    console.log('      Probablemente se interrumpió. Vuelve a lanzarlo para completarlo.\n');
  } else {
    console.log('   ✅ El crawl corrió y guardó los datos nuevos.');
    if (withStreams === 0) {
      console.log('      Nota: ninguna ficha tiene enlaces pre-resueltos → lanzaste el crawl SIN');
      console.log('      el flag --streams=300. No es grave (la primera apertura los resuelve y');
      console.log('      los guarda), pero con el flag la primera vez ya sale instantánea.\n');
    } else {
      console.log(`      ${withStreams} fichas abren ya con los enlaces listos.\n`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ checkCatalog:', err.message || err);
    process.exit(1);
  });
