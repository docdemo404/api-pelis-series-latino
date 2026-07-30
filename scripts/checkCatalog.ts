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
        imageHint: s.imageHint || null
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

  // Con --fallar-si-hay-cruces el script sale con código 1: es lo que pone en rojo la corrida
  // diaria del workflow si alguna vía de fusión vuelve a mezclar películas.
  if (cruce.cruzadas > 0 && process.argv.includes('--fallar-si-hay-cruces')) {
    console.log('\n❌ La invariante está rota: hay fichas sirviendo contenido de otras.\n');
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
