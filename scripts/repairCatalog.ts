/**
 * Reparación de fichas mal emparejadas contra TMDB.
 *
 *   npm run repair:catalog                        # solo informa (dry-run), no escribe nada
 *   npm run repair:catalog -- --list              # lista las fichas sospechosas y sale
 *   npm run repair:catalog -- --refetch           # reparación TOTAL: re-visita la página de
 *                                                 # origen (título original + imagen de TMDB) y
 *                                                 # re-fija la ficha correcta. Sigue en dry-run.
 *   npm run repair:catalog -- --refetch --apply   # …y lo aplica en Supabase
 *   npm run repair:catalog -- --apply             # aplica las correcciones en Supabase
 *   npm run repair:catalog -- --apply --dedupe    # además elimina duplicados rotos
 *   npm run repair:catalog -- --fuse              # informa de duplicados ENTRE FUENTES
 *   npm run repair:catalog -- --fuse --apply      # los funde bajo su ficha oficial de TMDB
 *   npm run repair:catalog -- --posters           # informa de poster/backdrop cruzados
 *   npm run repair:catalog -- --posters --apply   # los corrige con las imágenes de TMDB
 *   npm run repair:catalog -- --unfuse            # informa de fusiones erróneas
 *   npm run repair:catalog -- --unfuse --apply    # retira alias/fuentes que no corresponden
 *   npm run repair:catalog -- --reindex --apply   # reconstruye title_normalized
 *   npm run repair:catalog -- --aliases           # informa de títulos regionales que faltan
 *   npm run repair:catalog -- --aliases --apply   # añade los nombres regionales de TMDB a aliases
 *   npm run repair:catalog -- --verify            # repasa TODAS las fichas contra su página de
 *                                                 # origen (og:image + año + título original)
 *   npm run repair:catalog -- --verify --apply    # …y corrige/funde las que estén mal
 *   npm run repair:catalog -- --verify --restart  # ignora el punto de guardado y empieza de cero
 *
 * Por qué existe: el catálogo se pobló con un matcher que, ante títulos con artículo
 * inicial ("Los Vengadores…") o coletillas de pack ("Todas las temporadas"), obtenía cero
 * resultados de TMDB y acababa aceptando una ficha ajena — una parodia con 1 voto, o
 * directamente otra película. Esas filas quedaron guardadas con título, sinopsis y póster
 * equivocados. El matcher ya está corregido (src/services/tmdbService.ts), pero las filas
 * antiguas siguen mal: este script las detecta y las vuelve a resolver.
 *
 * Cómo detecta un error: reconstruye el título ORIGINAL desde el id de la fuente
 * (`2025-04-los-vengadores-era-de-ultron-2015-html` → "los vengadores era de ultron", 2015)
 * y lo compara con el título guardado, su original_title y sus alias. Si no se parece a
 * ninguno, la fila es sospechosa. Las traducciones legítimas ("Home Alone" → "Mi pobre
 * angelito") NO se marcan porque el original_title sí coincide con el slug.
 *
 * Seguridad: solo escribe cuando la nueva resolución da un tmdb_id DISTINTO y con un match
 * fiable. Si la re-resolución devuelve lo mismo, o no encuentra nada, la fila se deja intacta.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { TmdbService, tmdbImagePath } from '../src/services/tmdbService';
import { RealScraperService, SourceSignals } from '../src/services/realScraperService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, normalizeTitle, searchIndexKey, dedupeTitles, sourceTitleFromSlug } from '../src/utils/text';
import { MediaItem, ContentType } from '../src/types';

const db = getSupabaseAdmin();

/** Por debajo de esta similitud por palabras la ficha empieza a ser sospechosa. */
const SUSPICIOUS_BELOW = 0.65;

/**
 * …pero solo se marca si TAMBIÉN discrepa a nivel de caracteres. Muchos slugs pierden los
 * acentos al generarse ("fc-el-ping-ino" ← "El Pingüino", "fc-planeta-prehist-rico"), así
 * que por palabras parecen ajenos aunque la ficha guardada sea correcta.
 */
const CHAR_SIMILARITY_BELOW = 0.75;

/**
 * Ids que NO son slugs de título y por tanto no sirven para juzgar la ficha:
 * ids numéricos (tmdb), basura del CMS de la fuente y URLs hechas con la sinopsis.
 */
const JUNK_ID = /(sttpelicula|hdhd|\bsc\d+\b|\d{5,})/i;

/** Longitud de la subsecuencia común más larga (comparación a nivel de caracteres). */
function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Similitud 0..1 a nivel de caracteres sobre las claves canónicas. */
function charSimilarity(a: string, b: string): number {
  const ca = canonicalTitle(a);
  const cb = canonicalTitle(b);
  if (!ca || !cb) return 0;
  return (2 * lcsLength(ca, cb)) / (ca.length + cb.length);
}

/**
 * ¿El id sirve como referencia del título real? Descarta ids numéricos, basura del CMS
 * y slugs que en realidad son una frase de la sinopsis.
 */
function isTrustworthySlug(id: string, slugTitle: string): boolean {
  if (!slugTitle) return false;
  if (/^\d+$/.test(String(id).trim())) return false;
  if (JUNK_ID.test(id)) return false;
  // Slug URL-encoded ("al-l%C3%ADmite"): el título no se reconstruye limpio, así que no sirve
  // para juzgar la ficha ni para re-resolverla — se deja intacta en vez de arriesgar un cambio.
  if (/%[0-9a-f]{2}/i.test(id)) return false;

  const words = slugTitle.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;               // frase de sinopsis, no título
  if (words.filter(w => w.length > 2).length < 1) return false;
  return true;
}

/** Similitud 0..1 por solapamiento de palabras (misma semántica que el matcher). */
function similarity(a: string, b: string): number {
  const ca = canonicalTitle(a);
  const cb = canonicalTitle(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (ca.startsWith(cb) || cb.startsWith(ca)) return 0.85;
  if (ca.includes(cb) || cb.includes(ca)) return 0.7;

  const tokens = (s: string) => new Set(normalizeTitle(s).split(/[^a-z0-9]+/).filter(Boolean));
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach(t => { if (tb.has(t)) inter++; });
  return (2 * inter) / (ta.size + tb.size);
}

/**
 * Título y año originales según el id/slug de la fuente. La lógica vive en utils/text
 * (`sourceTitleFromSlug`), compartida con el enrichment: una única fuente de verdad.
 */
const sourceTitleFromId = sourceTitleFromSlug;

/** La url de origen de una fila, mire donde mire (`source_url` o el primero de `source_urls`). */
function sourceUrlOf(row: any): string {
  return row.source_url || (Array.isArray(row.source_urls) ? row.source_urls[0] : '') || '';
}

/**
 * Vuelve a la PÁGINA de origen a por las señales que el matcher necesita para acertar y que la
 * fila guardada ya no tiene fiables: el año, el título original real ("The Founder") y el
 * `og:image` de TMDB. Son independientes del match equivocado (el póster guardado es el de la
 * ficha ajena), así que sirven para RE-FIJAR la ficha correcta.
 *
 * Devuelve null si no hay url o falla la visita.
 */
async function refetchSourceSignals(row: any): Promise<SourceSignals | null> {
  // `fetchSourceSignals` hace UNA petición; el `scrapeDetail` que se usaba antes resolvía además
  // todos los servidores embed de la ficha para quedarse con dos campos, y por eso repasar el
  // catálogo entero era impensable.
  return RealScraperService.fetchSourceSignals(sourceUrlOf(row));
}

/**
 * ¿La ficha guardada corresponde al título del slug? Se compara con el título y con el
 * original_title: así una traducción legítima —"Home Alone" → "Mi pobre angelito"— no se
 * marca, porque el original_title sí coincide con el slug.
 *
 * Los ALIAS se excluyen a propósito: se rellenan con el título scrapeado de la fuente, de
 * modo que siempre coinciden con el slug y taparían justo los errores que buscamos.
 */
function looksLikeSameTitle(sourceTitle: string, row: any): boolean {
  const candidates: string[] = [row.title, row.original_title].filter(Boolean);
  return candidates.some(c =>
    similarity(sourceTitle, c) >= SUSPICIOUS_BELOW || charSimilarity(sourceTitle, c) >= CHAR_SIMILARITY_BELOW
  );
}

/** Número de secuela al final del título ("Cambio de bebés 2" → 2). */
function sequelNumber(title: string): number | null {
  const m = normalizeTitle(title).trim().match(/(?:^|\s)(\d{1,2})\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Criterio ESTRICTO de "es el mismo título", usado solo para decidir borrados.
 * Exige un parecido muy alto contra el título o el original_title de la gemela y que no
 * haya números de secuela discordantes: así "cambio de bebés" nunca borra por culpa de
 * "cambio de bebés 2", ni "la cortina de humo" por un "Humo" que solo la contiene.
 */
function isSameTitleStrict(sourceTitle: string, twin: any, sourceYear?: string): boolean {
  const candidates: string[] = [twin.title, twin.original_title].filter(Boolean);
  const sourceSeq = sequelNumber(sourceTitle);

  // Dos estrenos con el mismo nombre y años muy distintos son remakes/homónimos, no copias.
  const twinYear = Number(String(twin.release_date || '').slice(0, 4));
  if (sourceYear && twinYear && Math.abs(Number(sourceYear) - twinYear) > 2) return false;

  return candidates.some(c => {
    const twinSeq = sequelNumber(c);
    if ((sourceSeq ?? null) !== (twinSeq ?? null)) return false;
    return similarity(sourceTitle, c) >= 0.85;
  });
}

async function fetchAllRows(extraColumns: string[] = []): Promise<any[]> {
  const rows: any[] = [];
  const PAGE = 1000;
  const columns = ['id', 'tmdb_id', 'type', 'title', 'original_title', 'aliases', 'release_date', 'source_url', 'poster']
    .concat(extraColumns)
    .join(',');
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Comprueba si una columna opcional existe (misma técnica que refreshCatalog). */
async function hasColumn(column: string): Promise<boolean> {
  const { error } = await db.from('media_items').select(column).limit(1);
  return !error;
}

/**
 * Reconstruye `title_normalized` (la única columna sobre la que busca el RPC) para que
 * incluya el título original y los alias además del título mostrado. Sin esto, una ficha
 * guardada como "Avengers 2: Era de Ultrón" no aparece al buscar "vengadores".
 */
async function reindexSearchKeys(apply: boolean): Promise<void> {
  console.log('🔤 Reconstruyendo el índice de búsqueda (title_normalized)...');

  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,original_title,aliases,title_normalized')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const pending = rows
    .map(r => ({ id: r.id, key: searchIndexKey(r.title, r.original_title, r.aliases), current: r.title_normalized || '' }))
    .filter(r => r.key && r.key !== r.current);

  console.log(`   ${pending.length}/${rows.length} fichas con el índice desactualizado`);
  if (!apply || pending.length === 0) {
    if (!apply && pending.length > 0) console.log('   (dry-run: no se ha escrito nada)');
    return;
  }

  let updated = 0;
  const CHUNK = 25;
  for (let i = 0; i < pending.length; i += CHUNK) {
    await Promise.all(pending.slice(i, i + CHUNK).map(async p => {
      const { error } = await db.from('media_items').update({ title_normalized: p.key }).eq('id', p.id);
      if (!error) updated++;
    }));
  }
  console.log(`   ${updated} índices actualizados`);
}

/**
 * BACKFILL de títulos regionales (`--aliases`).
 *
 * La búsqueda solo mira `title_normalized`, que se arma con título + original + alias. Hasta
 * ahora los alias solo guardaban el nombre con que cada fuente scrapeó la ficha, de modo que
 * una película scrapeada únicamente como "Mi pobre angelito" NO aparecía al buscar "Solo en
 * casa" —su otro nombre regional—, aunque TMDB conoce ambos. El enriquecimiento ya rellena los
 * alias con los nombres regionales (tmdbService.collectAliases), pero las filas ya guardadas
 * siguen sin ellos hasta el próximo crawl completo.
 *
 * Este modo recorre las fichas YA emparejadas con TMDB, pide sus títulos alternativos y
 * traducciones en español, los añade a `aliases` y reconstruye title_normalized. A partir de
 * aquí la ficha se encuentra por cualquiera de sus nombres, sin re-scrapear nada.
 */
async function backfillRegionalAliases(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`🌎 Añadiendo títulos regionales desde TMDB${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const withNormalized = await hasColumn('title_normalized');

  // Solo las fichas con match REAL en TMDB (id positivo): las sintéticas no tienen ficha de
  // la que sacar títulos alternativos (para fundirlas primero, ver --fuse).
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,original_title,aliases')
      .gt('tmdb_id', 0)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`   ${rows.length} fichas emparejadas con TMDB`);

  const targets = Number.isFinite(limitArg) && (limitArg as number) > 0 ? rows.slice(0, limitArg) : rows;
  let grown = 0;
  let unchanged = 0;
  let failed = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    const resolved = await Promise.all(chunk.map(async row => {
      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
      try {
        const details = await TmdbService.getTmdbDetails(row.tmdb_id, type);
        return { row, known: details ? TmdbService.collectAliases(details) : [] };
      } catch {
        return { row, known: [] as string[] };
      }
    }));

    for (const { row, known } of resolved) {
      const current: string[] = row.aliases || [];
      // El título mostrado se conserva SIEMPRE el primero para no alterar el ranking por prefijo.
      const merged = dedupeTitles([...current, row.title, ...known]);
      if (merged.length <= current.length) {
        unchanged++;
        continue;
      }

      const patch: Record<string, unknown> = { aliases: merged };
      if (withNormalized) patch.title_normalized = searchIndexKey(row.title, row.original_title, merged);

      const added = merged.filter(a => !current.some(c => normalizeTitle(c) === normalizeTitle(a)));
      console.log(`   + ${row.id}\n     "${row.title}" gana ${JSON.stringify(added)}`);

      if (apply) {
        const { error } = await db.from('media_items').update(patch).eq('id', row.id);
        if (error) { console.warn(`     ⚠ ${error.message}`); failed++; continue; }
      }
      grown++;
    }
  }

  console.log(
    `\n${apply ? '✅ Alias añadidos' : '📋 Dry-run'}: ${grown} fichas ${apply ? 'ampliadas' : 'a ampliar'}, ` +
    `${unchanged} ya completas, ${failed} fallidas`
  );
  if (!apply && grown > 0) console.log('   Ejecuta de nuevo con --apply para escribir los cambios.');
}

/** Todas las fichas con tmdb_id SINTÉTICO (negativo): las que no emparejaron con TMDB. */
async function fetchSyntheticRows(): Promise<any[]> {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,original_title,aliases,release_date,source_url')
      .lt('tmdb_id', 0)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * FUSIÓN de fichas duplicadas entre fuentes (`--fuse`).
 *
 * Un título cuyo match contra TMDB falla recibe un tmdb_id SINTÉTICO negativo y entra en el
 * catálogo como una entidad propia. Cuando la MISMA película sí emparejó desde la otra
 * fuente, quedan dos fichas del mismo contenido con los servidores repartidos entre ambas:
 *   "Minions: Nace un villano"   tmdb  438148      (FuegoCine)
 *   "Minions: El origen de Gru"  tmdb -1750683933  (TioPlus, título de España)
 *
 * El matcher ya resuelve estos casos —consulta los títulos alternativos de TMDB, ver
 * tmdbService.scoreAgainstKnownTitles—, así que aquí se re-resuelven las fichas sintéticas:
 *   · si el tmdb_id real está LIBRE  → la ficha lo adopta y deja de ser sintética;
 *   · si ya lo ocupa otra fila       → esta es un DUPLICADO: se vuelca en la canónica lo
 *     único que aporta (su página de origen y sus nombres) y se elimina.
 *
 * Solo se borra con un match casi exacto: un parecido moderado no basta para fundir fichas.
 */
async function fuseSyntheticDuplicates(apply: boolean, limitArg?: number): Promise<void> {
  const DELETE_SCORE = 0.9;

  console.log(`🔗 Buscando duplicados entre fuentes${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const withMultiSource = await hasColumn('source_urls');
  if (!withMultiSource) {
    console.warn('   ⚠ Columna source_urls ausente — ejecuta src/db/migrations/005_multisource_and_availability.sql.');
    console.warn('     Sin ella la fusión perdería la fuente de la ficha absorbida: se aborta.');
    return;
  }

  const rows = await fetchSyntheticRows();
  console.log(`   ${rows.length} fichas sin match en TMDB (tmdb_id sintético)`);
  const targets = Number.isFinite(limitArg) && (limitArg as number) > 0 ? rows.slice(0, limitArg) : rows;

  let fused = 0;
  let adopted = 0;
  let stillUnmatched = 0;
  let skipped = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    const results = await Promise.all(chunk.map(async row => {
      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
      const year = String(row.release_date || '').slice(0, 4) || sourceTitleFromId(row.id).year;
      try {
        return { row, type, match: await TmdbService.resolveTmdb(row.title, type, year || undefined, row.id) };
      } catch {
        return { row, type, match: null };
      }
    }));

    for (const { row, type, match } of results) {
      if (!match || !match.matched || match.id <= 0) {
        stillUnmatched++;
        continue;
      }

      const { data: clash } = await db
        .from('media_items')
        .select('id,title,original_title,aliases,source_url,source_urls')
        .eq('tmdb_id', match.id)
        .neq('id', row.id)
        .limit(1);

      // a) El tmdb_id real está libre: la ficha lo adopta y deja de ser un duplicado
      //    en potencia (el próximo crawl ya la fusionará por tmdb_id si toca).
      if (!clash || clash.length === 0) {
        console.log(`   ↑ ${row.id}\n     "${row.title}" adopta tmdb ${match.id} (score ${match.score.toFixed(2)})`);
        if (apply) {
          const { error } = await db
            .from('media_items')
            .update({ tmdb_id: match.id, updated_at: new Date().toISOString() })
            .eq('id', row.id);
          if (error) {
            console.warn(`     ⚠ no se pudo adoptar: ${error.message}`);
            continue;
          }
        }
        adopted++;
        continue;
      }

      const twin = clash[0];
      if (match.score < DELETE_SCORE) {
        skipped++;
        console.log(`   ! ${row.id}\n     "${row.title}" ~ ${twin.id} = "${twin.title}" (score ${match.score.toFixed(2)} < ${DELETE_SCORE}: no se funde)`);
        continue;
      }

      // Segunda llave antes de borrar: que TMDB reconozca ESTE título como uno de los
      // nombres de la ficha canónica. La puntuación del matcher sola no basta —puede
      // acertar de más y arrastrar una película entera a la ficha equivocada—, y comparar
      // los dos títulos entre sí tampoco, porque las variantes regionales legítimas no se
      // parecen. Sin esta comprobación, "Solo en casa 4" acabó absorbida por "Yu-Gi-Oh! GX".
      const confirmed = await TmdbService.confirmsTitle(match.id, type, row.title).catch(() => false);
      if (!confirmed) {
        skipped++;
        console.log(`   ! ${row.id}\n     "${row.title}" → tmdb ${match.id} = "${twin.title}", pero TMDB no registra ese nombre para la ficha: no se funde`);
        continue;
      }

      // b) DUPLICADO confirmado. Lo único que esta copia aporta es su página de origen
      //    (sus servidores) y su nombre regional: ambos se vuelcan en la ficha canónica
      //    ANTES de borrarla, o se perderían.
      const currentUrls: string[] = twin.source_urls || [];
      const mergedUrls = Array.from(
        new Set([...currentUrls, twin.source_url, row.source_url].filter(Boolean) as string[])
      );
      const currentAliases: string[] = twin.aliases || [];
      const mergedAliases = Array.from(
        new Set([...currentAliases, ...(row.aliases || []), row.title].filter(Boolean) as string[])
      );

      const patch: Record<string, unknown> = {};
      if (mergedUrls.length > currentUrls.length) patch.source_urls = mergedUrls;
      if (mergedAliases.length > currentAliases.length) {
        patch.aliases = mergedAliases;
        patch.title_normalized = searchIndexKey(twin.title, twin.original_title, mergedAliases);
      }

      console.log(
        `   ⇄ ${row.id}\n     "${row.title}" se funde en ${twin.id} = "${twin.title}" (tmdb ${match.id})` +
        `\n       fuentes: ${currentUrls.length} → ${mergedUrls.length} · alias: ${currentAliases.length} → ${mergedAliases.length}`
      );

      if (apply) {
        if (Object.keys(patch).length > 0) {
          const { error } = await db.from('media_items').update(patch).eq('id', twin.id);
          if (error) {
            console.warn(`     ⚠ no se pudo enriquecer la ficha canónica: ${error.message} (no se borra el duplicado)`);
            skipped++;
            continue;
          }
        }
        const { error: delError } = await db.from('media_items').delete().eq('id', row.id);
        if (delError) {
          console.warn(`     ⚠ no se pudo borrar el duplicado: ${delError.message}`);
          skipped++;
          continue;
        }
      }
      fused++;
    }
  }

  console.log(
    `\n${apply ? '✅ Fusión aplicada' : '📋 Dry-run'}: ${fused} duplicados ${apply ? 'fusionados' : 'a fusionar'}, ` +
    `${adopted} fichas ${apply ? 'adoptaron' : 'adoptarían'} su tmdb_id real, ` +
    `${skipped} omitidas por parecido insuficiente, ${stillUnmatched} siguen sin match en TMDB`
  );
  if (!apply && (fused > 0 || adopted > 0)) console.log('   Ejecuta de nuevo con --apply para escribir los cambios.');
}

/**
 * VERIFICACIÓN contra la página de origen (`--verify`).
 *
 * Los otros modos juzgan una ficha comparando TÍTULOS, y ahí se acaba su alcance: la mayoría de
 * las filas que no se parecen a su slug son retítulos regionales CORRECTOS ("infiltrados-en-clase"
 * → 21 Jump Street, "corrupcion-en-miami" → Miami Vice), mientras que los errores de verdad
 * pueden llevar el título calcado —una "Sin salida" de 2024 en el sitio de una de 1993—. Por
 * parecido de títulos, ni se distinguen ni se detectan.
 *
 * Este modo no compara títulos: vuelve a la página de la que salió cada ficha y usa lo que ella
 * publica, en tres etapas de coste creciente.
 *
 *   1. El `og:image` de TioPlus apunta a `image.tmdb.org/…/<hash>.jpg`, y ese hash identifica UNA
 *      ficha concreta. Si coincide con el póster o el fondo de la ficha guardada, es correcta.
 *   2. Si no coincide (la página pudo poner el póster de otro idioma), se re-resuelve con las
 *      señales completas de la página —título, año, título original e imagen—. Si sale el mismo
 *      tmdb_id, correcta.
 *   3. Si sale otro y viene RESPALDADO (`match.verified`), la ficha estaba mal. Se corrige; si el
 *      tmdb_id correcto ya lo ocupa otra fila, esta es un duplicado y se funde en aquella.
 *
 * Sin respaldo NO se escribe nada: se informa y se pasa. Una página caída tampoco es motivo para
 * tocar una ficha. Es una pasada larga (una petición por ficha), así que guarda el avance y se
 * puede reanudar.
 */
/**
 * El punto de guardado va SEPARADO por modo: si el dry-run marcase las fichas como repasadas,
 * la pasada real con --apply se las saltaría enteras y no corregiría nada.
 */
/**
 * Reescribe una fila con la ficha que de verdad le corresponde, re-enriquecida desde TMDB a
 * partir del título REAL que publica su página. Devuelve el título nuevo, o null si falló.
 */
async function rewriteRowFromMatch(
  row: any,
  type: ContentType,
  tmdbId: number,
  signals: SourceSignals,
  opts: { apply: boolean; withMetadataSource: boolean; quiet?: boolean }
): Promise<{ title: string | null; taken: boolean }> {
  const base: MediaItem = {
    id: row.id,
    tmdb_id: tmdbId,
    imdb_id: null,
    type,
    title: signals.title,
    original_title: signals.originalTitle || signals.title,
    aliases: dedupeTitles([signals.title, row.title]),
    overview: '',
    rating: 0,
    release_date: signals.year || '',
    genres: [],
    subcategories: [],
    poster: null,
    backdrop: null,
    logo: null,
    trailer: null,
    cast: [],
    dubbing_cast: []
  };

  const enriched = await TmdbService.enrichMediaItem(base, { skipSeasons: true });
  if (!opts.apply) return { title: enriched.title, taken: false };

  const update: Record<string, unknown> = {
    tmdb_id: enriched.tmdb_id,
    type: enriched.type,
    title: enriched.title,
    original_title: enriched.original_title || enriched.title,
    title_normalized: searchIndexKey(enriched.title, enriched.original_title, enriched.aliases),
    aliases: enriched.aliases || [],
    tagline: enriched.tagline || '',
    overview: enriched.overview || '',
    rating: enriched.rating || 0,
    content_rating: enriched.content_rating || null,
    release_date: enriched.release_date || '',
    genres: enriched.genres || [],
    poster: enriched.poster,
    backdrop: enriched.backdrop,
    logo: enriched.logo,
    trailer: enriched.trailer,
    cast_data: (enriched.cast_details && enriched.cast_details.length ? enriched.cast_details : enriched.cast) || [],
    total_seasons: enriched.total_seasons || 0,
    total_episodes: enriched.total_episodes || 0,
    updated_at: new Date().toISOString()
  };
  if (opts.withMetadataSource) update.metadata_source = enriched.metadata_source || 'tmdb';

  const { error } = await db.from('media_items').update(update).eq('id', row.id);
  if (error) {
    // 23505 = violación de unicidad: el id ya lo tiene otra fila. Quien lo decide es la
    // restricción de la tabla, no una suposición del script: si el UNIQUE se amplió a
    // (tmdb_id, type) —migración 006— una película y una serie pueden compartir número y
    // esta escritura entra sin más. Presuponer el choque era negarse a algo ya permitido.
    const taken = error.code === '23505';
    if (!taken || !opts.quiet) console.warn(`     ⚠ no se pudo guardar ${row.id}: ${error.message}`);
    return { title: null, taken };
  }
  return { title: enriched.title, taken: false };
}

/**
 * Funde una fila dentro de la que ya tiene su ficha oficial y la elimina.
 *
 * Lo único que la copia aporta son su(s) página(s) de origen —sus servidores, a menudo de otra
 * fuente distinta a la de la gemela— y sus nombres: se vuelcan en la canónica ANTES de borrar,
 * o al eliminar la fila se perderían enlaces de reproducción.
 */
async function fuseRowInto(
  row: any,
  twin: any,
  extraAliases: string[],
  opts: { apply: boolean; withMultiSource: boolean }
): Promise<{ ok: boolean; urls: [number, number]; aliases: [number, number] }> {
  const currentUrls: string[] = twin.source_urls || [];
  const mergedUrls = Array.from(new Set(
    [...currentUrls, twin.source_url, ...(row.source_urls || []), row.source_url].filter(Boolean) as string[]
  ));
  const currentAliases: string[] = twin.aliases || [];
  const mergedAliases = dedupeTitles([...currentAliases, ...(row.aliases || []), row.title, ...extraAliases]);

  const sizes = {
    urls: [currentUrls.length, mergedUrls.length] as [number, number],
    aliases: [currentAliases.length, mergedAliases.length] as [number, number]
  };
  if (!opts.apply) return { ok: true, ...sizes };

  const patch: Record<string, unknown> = {};
  if (opts.withMultiSource && mergedUrls.length > currentUrls.length) patch.source_urls = mergedUrls;
  if (mergedAliases.length > currentAliases.length) {
    patch.aliases = mergedAliases;
    patch.title_normalized = searchIndexKey(twin.title, twin.original_title, mergedAliases);
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await db.from('media_items').update(patch).eq('id', twin.id);
    if (error) {
      console.warn(`     ⚠ no se pudo enriquecer ${twin.id}: ${error.message} (no se borra el duplicado)`);
      return { ok: false, ...sizes };
    }
  }
  const { error: delErr } = await db.from('media_items').delete().eq('id', row.id);
  if (delErr) {
    console.warn(`     ⚠ no se pudo borrar ${row.id}: ${delErr.message}`);
    return { ok: false, ...sizes };
  }
  return { ok: true, ...sizes };
}

/**
 * Intenta DESALOJAR al ocupante de un tmdb_id verificándolo contra SU propia página.
 *
 * La columna `tmdb_id` es UNIQUE para películas y series a la vez, pero TMDB las numera por
 * separado y los números se repiten, así que una ficha correcta puede encontrarse su hueco
 * ocupado por otra que no tiene nada que ver. Ahora bien, en la práctica el ocupante suele ser
 * el que está mal: la fila `campanilla` guardaba "Road Dogz" (movie 108291) cuando su página
 * dice Tinker Bell (2008), y era ella quien le bloqueaba el número a la serie "Snowdrop"
 * (tv 108291). Corregir al ocupante libera el hueco y las DOS fichas quedan bien.
 *
 * Solo se mueve al ocupante si su propia página lo desmiente con respaldo, y nunca en cadena:
 * si su id correcto también está pillado, se deja todo como está.
 */
async function relocateOccupant(
  twin: any,
  opts: { apply: boolean; withMetadataSource: boolean; withMultiSource: boolean }
): Promise<{ freed: boolean; reason: string }> {
  const twinType: ContentType = twin.type === 'tvseries' ? 'tvseries' : 'movie';
  const signals = await refetchSourceSignals(twin);
  if (!signals || !signals.title) return { freed: false, reason: 'su página no responde' };

  const own = await TmdbService.resolveTmdb(signals.title, twinType, signals.year || undefined, twin.id, {
    originalTitle: signals.originalTitle || null,
    imageHint: signals.imageHint || null
  }).catch(() => null);

  if (!own || !own.matched || !own.verified) return { freed: false, reason: 'su página no confirma otra ficha' };
  if (own.id === twin.tmdb_id) return { freed: false, reason: 'su página confirma que el id es suyo' };
  if (own.type !== twinType) return { freed: false, reason: 'su ficha correcta es de otro catálogo' };

  const { data: nextClash } = await db
    .from('media_items')
    .select(opts.withMultiSource
      ? 'id,type,title,original_title,aliases,source_url,source_urls'
      : 'id,type,title,original_title,aliases,source_url')
    .eq('tmdb_id', own.id)
    .neq('id', twin.id)
    .limit(1);

  const owner: any = nextClash && nextClash.length > 0 ? nextClash[0] : null;

  // Su ficha correcta ya está en el catálogo: entonces el ocupante no es una fila que haya que
  // mover, es un DUPLICADO de aquella. Fundirlo la enriquece con su fuente y libera el número
  // igual de bien. Es el caso real: `campanilla` guardaba "Road Dogz" (108291) cuando su página
  // dice Tinker Bell, y Tinker Bell (13179) ya existía como ficha de FuegoCine.
  if (owner) {
    if ((owner.type === 'tvseries' ? 'tvseries' : 'movie') !== own.type) {
      return { freed: false, reason: `su id correcto (${own.id}) lo ocupa una ficha de otro catálogo` };
    }
    const merged = await fuseRowInto(twin, owner, [signals.title], opts);
    if (!merged.ok) return { freed: false, reason: 'no se pudo fundir con su ficha oficial' };
    console.log(
      `     ↳ se desaloja ${twin.id}: "${twin.title}" era un duplicado de ${owner.id} = "${owner.title}" (tmdb ${own.id}), su página dice "${signals.title}" ${signals.year || 's/a'}` +
      `\n       se funde ahí (fuentes ${merged.urls[0]}→${merged.urls[1]}, alias ${merged.aliases[0]}→${merged.aliases[1]}) y libera el ${twin.tmdb_id}`
    );
    return { freed: true, reason: '' };
  }

  const moved = await rewriteRowFromMatch(twin, twinType, own.id, signals, opts);
  if (!moved.title) return { freed: false, reason: 'no se pudo reescribir' };

  console.log(`     ↳ se desaloja ${twin.id}: "${twin.title}" → "${moved.title}" (tmdb ${twin.tmdb_id} → ${own.id}), su página dice "${signals.title}" ${signals.year || 's/a'}`);
  return { freed: true, reason: '' };
}

const verifyCheckpointFile = (apply: boolean) =>
  apply ? 'repair_verify_progress.json' : 'repair_verify_progress.dry.json';

/** Ids ya repasados en ejecuciones anteriores, para reanudar donde se dejó. */
function loadCheckpoint(file: string, restart: boolean): Set<string> {
  if (restart) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

function saveCheckpoint(file: string, done: Set<string>): void {
  try {
    fs.writeFileSync(file, JSON.stringify(Array.from(done)));
  } catch (err: any) {
    console.warn(`   ⚠ no se pudo guardar el avance: ${err.message}`);
  }
}

async function verifyAgainstSource(apply: boolean, limitArg?: number, restart = false): Promise<void> {
  console.log(`🔬 Verificando fichas contra su página de origen${apply ? '' : ' (dry-run: no se escribe nada)'}...`);

  const withMultiSource = await hasColumn('source_urls');
  const withMetadataSource = await hasColumn('metadata_source');

  const checkpoint = verifyCheckpointFile(apply);
  const done = loadCheckpoint(checkpoint, restart);
  if (done.size > 0) console.log(`   ↻ reanudando: ${done.size} fichas ya repasadas (usa --restart para empezar de cero)`);

  const extraColumns = [
    ...(withMultiSource ? ['source_urls'] : []),
    ...(withMetadataSource ? ['metadata_source'] : [])
  ];
  const rows = (await fetchAllRows(extraColumns))
    .filter(row => sourceUrlOf(row) && !done.has(row.id));
  const targets = Number.isFinite(limitArg) && (limitArg as number) > 0 ? rows.slice(0, limitArg) : rows;
  console.log(`   ${targets.length} fichas por repasar`);

  let okImage = 0;
  let okRematch = 0;
  let fixed = 0;
  let fused = 0;
  let doubtful = 0;
  let noSignals = 0;
  let unresolved = 0;
  /** Fichas que le robaban el número a otra y su propia página desmintió: se movieron. */
  let relocated = 0;
  /** Choques de id entre catálogos que NO se pudieron deshacer (requieren la migración 006). */
  let blocked = 0;

  const CONCURRENCY = 6;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    const results = await Promise.all(chunk.map(async row => {
      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
      const signals = await refetchSourceSignals(row);
      if (!signals || !signals.title) return { row, type, signals: null, confirmedByImage: false, match: null };

      // Etapa 1: el hash del og:image contra las imágenes de la ficha guardada.
      const sourceImage = tmdbImagePath(signals.imageHint);
      if (sourceImage && row.tmdb_id > 0) {
        const stored = await TmdbService.getTmdbDetails(row.tmdb_id, type).catch(() => null);
        const confirmed = !!stored && (
          sourceImage === tmdbImagePath(stored.poster_path) ||
          sourceImage === tmdbImagePath(stored.backdrop_path)
        );
        if (confirmed) return { row, type, signals, confirmedByImage: true, match: null };
      }

      // Etapa 2: re-resolver con TODO lo que publica la página.
      const match = await TmdbService.resolveTmdb(signals.title, type, signals.year || undefined, row.id, {
        originalTitle: signals.originalTitle || null,
        imageHint: signals.imageHint || null
      }).catch(() => null);

      return { row, type, signals, confirmedByImage: false, match };
    }));

    for (const { row, type, signals, confirmedByImage, match } of results) {
      done.add(row.id);

      if (!signals) {
        noSignals++;
        continue;
      }
      if (confirmedByImage) {
        // Confirmar que la ficha es la correcta no dice que esté RELLENA: si TMDB falló al pedir
        // los detalles en su día, la fila conserva el id bueno con la metadata del sitio de
        // origen. Se rellena aquí también, o esta vía la daría por buena para siempre.
        if (withMetadataSource && row.tmdb_id > 0 && row.metadata_source === 'source') {
          const filled = await rewriteRowFromMatch(row, type, row.tmdb_id, signals, { apply, withMetadataSource });
          if (filled.title) {
            console.log(`   ✓ ${row.id}\n     "${row.title}" estaba confirmada por imagen pero sin metadata de TMDB → "${filled.title}"`);
            fixed++;
            continue;
          }
        }
        okImage++;
        continue;
      }
      if (!match || !match.matched) {
        unresolved++;
        console.log(`   ? ${row.id}\n     "${row.title}" · la fuente dice "${signals.title}" (${signals.year || 'sin año'}) y no hay match fiable: se deja igual`);
        continue;
      }
      // Coincidir en el NÚMERO no basta: tiene que ser del mismo catálogo. `submundo` estaba
      // guardada como serie con el id 957951, que es de una película, así que pedir su ficha
      // devolvía 404 y la fila se quedaba sin metadata para siempre, dándose por correcta en
      // cada revisión. Cuando el match dice otro catálogo, lo que hay que arreglar es el tipo.
      if (match.id === row.tmdb_id && match.type === type) {
        // El id es el bueno, pero la ficha puede no haberse llegado a rellenar: si TMDB falla al
        // pedir los detalles, el enriquecido conserva el id real y se queda con la metadata del
        // sitio de origen (`metadata_source: 'source'`), es decir, sin sinopsis, sin géneros y
        // con el póster de la fuente. Coincidir en el id no basta para darla por buena.
        if (withMetadataSource && row.tmdb_id > 0 && row.metadata_source === 'source') {
          const filled = await rewriteRowFromMatch(row, match.type, match.id, signals, { apply, withMetadataSource });
          if (filled.title) {
            console.log(`   ✓ ${row.id}\n     "${row.title}" tenía el id correcto (${match.id}) pero sin metadata de TMDB → "${filled.title}"`);
            fixed++;
          }
          continue;
        }
        okRematch++;
        continue;
      }

      // Un id distinto SIN respaldo no autoriza a escribir: podría ser el matcher acertando de
      // menos, y sustituir una ficha buena por otra es exactamente el daño que se quiere evitar.
      if (!match.verified) {
        doubtful++;
        console.log(`   ~ ${row.id}\n     "${row.title}" (tmdb ${row.tmdb_id}) · la fuente sugiere tmdb ${match.id} pero sin respaldo (score ${match.score.toFixed(2)}): solo se informa`);
        continue;
      }

      const clashColumns = withMultiSource
        ? 'id,tmdb_id,type,title,original_title,aliases,source_url,source_urls'
        : 'id,tmdb_id,type,title,original_title,aliases,source_url';
      const { data: clash } = await db
        .from('media_items').select(clashColumns).eq('tmdb_id', match.id).neq('id', row.id).limit(1);

      let twin: any = clash && clash.length > 0 ? clash[0] : null;

      // Mismo número, otro catálogo: NO es un duplicado. TMDB numera películas y series por
      // separado y los ids se repiten, pero la columna tmdb_id es UNIQUE para las dos, así que
      // la serie "Snowdrop" (tv 108291) choca con la película "Road Dogz" (movie 108291) sin
      // tener nada que ver. Fundirlas mezclaría dos títulos ajenos.
      //
      // Casi siempre el que sobra es el OCUPANTE, no quien reclama el número: "Road Dogz" estaba
      // en la fila `campanilla`, cuya página dice Tinker Bell (2008). Así que antes de rendirse
      // se le da a esa fila su propia verificación; si su página la desmiente, se corrige, el
      // hueco queda libre y las dos fichas acaban bien.
      if (twin && (twin.type === 'tvseries' ? 'tvseries' : 'movie') !== match.type) {
        // Que el número lo tenga una ficha del OTRO catálogo puede no ser ningún impedimento:
        // con el UNIQUE ampliado a (tmdb_id, type) —migración 006— una película y una serie
        // conviven con el mismo número, que es lo que TMDB hace de partida. Así que primero se
        // INTENTA escribir y se deja que responda la restricción de la tabla; solo si la rechaza
        // se busca desalojar al ocupante, y solo si eso tampoco puede, se da por bloqueada.
        const direct = await rewriteRowFromMatch(row, match.type, match.id, signals, { apply, withMetadataSource, quiet: true });
        if (direct.title) {
          console.log(`   ✓ ${row.id}\n     "${row.title}" → "${direct.title}" (tmdb ${row.tmdb_id} → ${match.id}, comparte número con ${twin.id} pero en otro catálogo)`);
          fixed++;
          continue;
        }
        if (!direct.taken) continue;

        const evicted = await relocateOccupant(twin, { apply, withMetadataSource, withMultiSource });
        if (!evicted.freed) {
          blocked++;
          console.log(
            `   ! ${row.id}\n     "${row.title}" es tmdb ${match.id} (${match.type}), pero ese número lo ocupa ${twin.id} = "${twin.title}" (${twin.type}), y ${evicted.reason}.` +
            `\n       Son fichas distintas con el mismo id en catálogos distintos: no se toca ninguna (ver migración 006).`
          );
          continue;
        }
        relocated++;
        twin = null;
      }

      // El tmdb_id es UNIQUE: si la ficha correcta ya está en el catálogo, esta fila es un
      // DUPLICADO. Lo único que aporta son su página de origen (sus servidores, a menudo de otra
      // fuente) y su nombre: se vuelcan en la canónica ANTES de borrarla o se perderían enlaces.
      if (twin) {
        const merged = await fuseRowInto(row, twin, [signals.title], { apply, withMultiSource });
        if (!merged.ok) continue;
        console.log(
          `   ⇄ ${row.id}\n     "${row.title}" (tmdb ${row.tmdb_id}) era en realidad "${signals.title}" = tmdb ${match.id}, que ya es ${twin.id} = "${twin.title}"` +
          `\n       se funde ahí (fuentes ${merged.urls[0]}→${merged.urls[1]}, alias ${merged.aliases[0]}→${merged.aliases[1]}) y se elimina el duplicado`
        );
        fused++;
        continue;
      }

      // Ficha nueva completa, partiendo del título REAL que publica la fuente.
      const rewritten = await rewriteRowFromMatch(row, match.type, match.id, signals, { apply, withMetadataSource });
      if (rewritten.title) {
        console.log(`   ✓ ${row.id}\n     "${row.title}" → "${rewritten.title}" (tmdb ${row.tmdb_id} → ${match.id}, la fuente dice "${signals.title}" ${signals.year || 's/a'})`);
        fixed++;
      }
    }

    saveCheckpoint(checkpoint, done);
    const seen = Math.min(i + CONCURRENCY, targets.length);
    if (seen % 300 === 0 || seen === targets.length) {
      console.log(`   …${seen}/${targets.length} · ${okImage + okRematch} correctas · ${fixed + fused + relocated} con problema · ${doubtful} dudosas · ${blocked} bloqueadas`);
    }
  }

  console.log(
    `\n${apply ? '✅ Verificación aplicada' : '📋 Dry-run'}: ` +
    `${okImage} confirmadas por imagen, ${okRematch} confirmadas al re-resolver, ` +
    `${fixed} ${apply ? 'corregidas' : 'a corregir'}, ${fused} duplicados ${apply ? 'fundidos' : 'a fundir'}, ` +
    `${relocated} ocupantes ${apply ? 'desalojadas' : 'a desalojar'} de un id ajeno, ` +
    `${doubtful} dudosas (solo informadas), ${blocked} bloqueadas por choque de id entre catálogos, ` +
    `${unresolved} sin match fiable, ${noSignals} sin señales en su página`
  );
  if (blocked > 0) {
    console.log(`   ⚠ ${blocked} choques no se pueden deshacer sin ampliar el UNIQUE de tmdb_id: aplica src/db/migrations/006_tmdb_id_unique_por_tipo.sql`);
  }
  if (!apply && (fixed > 0 || fused > 0)) console.log('   Ejecuta de nuevo con --verify --apply para escribir los cambios.');
}

/**
 * LIMPIEZA de fusiones erróneas (`--unfuse`).
 *
 * Al fundir duplicados, la ficha superviviente absorbe el nombre y la URL de origen de la
 * absorbida. Si esa fusión no debió ocurrir, la ficha canónica se queda con un alias y una
 * fuente que no le corresponden ("Yu-Gi-Oh! GX" con el alias "Solo en casa 4" y un enlace a
 * /pelicula/solo-en-casa-4), lo que además contamina el índice de búsqueda.
 *
 * Se recorren las fichas fusionadas y se retira todo alias que TMDB NO reconozca como
 * nombre de esa ficha, junto con la URL de origen que llegó con él. Los alias legítimos
 * —las variantes regionales de verdad— los confirma TMDB y se conservan.
 */
async function unfuseWrongMerges(apply: boolean): Promise<void> {
  console.log(`🧹 Buscando fusiones erróneas${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const withNormalized = await hasColumn('title_normalized');

  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,original_title,aliases,source_urls,source_url')
      .gt('tmdb_id', 0)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const merged = rows.filter(r => (r.aliases || []).length > 1 || (r.source_urls || []).length > 1);
  console.log(`   ${merged.length} fichas con señales de fusión`);

  let cleaned = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < merged.length; i += CONCURRENCY) {
    const chunk = merged.slice(i, i + CONCURRENCY);

    const checked = await Promise.all(chunk.map(async row => {
      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
      const orphans: string[] = [];
      for (const alias of row.aliases || []) {
        // El propio título nunca es huérfano, y una variante regional la confirma TMDB.
        if (similarity(alias, row.title) >= 0.6 || similarity(alias, row.original_title || '') >= 0.6) continue;
        const ok = await TmdbService.confirmsTitle(row.tmdb_id, type, alias).catch(() => true);
        if (!ok) orphans.push(alias);
      }
      return { row, orphans };
    }));

    for (const { row, orphans } of checked) {
      if (orphans.length === 0) continue;

      const keptAliases = (row.aliases || []).filter((a: string) => !orphans.includes(a));
      // La URL de origen que entró con el alias huérfano se reconoce por su slug.
      const keptUrls = (row.source_urls || []).filter((u: string) => {
        const slug = String(u).toLowerCase();
        return !orphans.some(o => slug.includes(slugOf(o)));
      });

      const patch: Record<string, unknown> = { aliases: keptAliases };
      if (keptUrls.length !== (row.source_urls || []).length) patch.source_urls = keptUrls;
      if (withNormalized) patch.title_normalized = searchIndexKey(row.title, row.original_title, keptAliases);

      console.log(
        `   ␡ ${row.id} "${row.title}"\n     retira ${JSON.stringify(orphans)}` +
        (patch.source_urls ? ` y ${(row.source_urls || []).length - keptUrls.length} fuente(s)` : '')
      );

      if (apply) {
        const { error } = await db.from('media_items').update(patch).eq('id', row.id);
        if (error) { console.warn(`     ⚠ ${error.message}`); continue; }
      }
      cleaned++;
    }
  }

  console.log(`\n${apply ? '✅ Limpieza aplicada' : '📋 Dry-run'}: ${cleaned} fichas ${apply ? 'depuradas' : 'a depurar'}`);
  if (cleaned > 0) {
    console.log('   Las filas borradas por esas fusiones las recrea el próximo `npm run refresh:catalog`.');
  }
  if (!apply && cleaned > 0) console.log('   Ejecuta de nuevo con --apply para escribir los cambios.');
}

/** Slug de un título, para reconocer la URL de origen que llegó con él. */
function slugOf(title: string): string {
  return normalizeTitle(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Nombre de fichero de una URL de imagen, ignorando el prefijo de tamaño de TMDB. */
function imageFile(url: string | null): string | null {
  const m = String(url || '').match(/\/([^/]+\.(?:jpg|png|webp|svg))$/i);
  return m ? m[1] : null;
}

/**
 * REPARACIÓN de imágenes cruzadas (`--posters`).
 *
 * `poster` (vertical) y `backdrop` (apaisado) no son intercambiables, pero el fallback de
 * metadata rellenaba uno con el otro cuando la fuente solo traía una imagen. El resultado
 * son fichas donde ambos campos apuntan al MISMO fichero, así que una de las dos
 * orientaciones es necesariamente falsa.
 *
 * En el catálogo actual todas las filas afectadas comparten además el tamaño (w342/w342):
 * es el póster vertical bueno copiado al backdrop, no al revés. Así que el póster se
 * respeta y lo que se corrige es el backdrop:
 *   · si la ficha empareja ahora con TMDB → se escriben las DOS imágenes oficiales;
 *   · si no empareja → se deja el póster y se vacía el backdrop, porque no tenemos
 *     ninguna imagen apaisada real y un vertical estirado se ve peor que ninguna.
 */
async function repairCrossedImages(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`🖼️  Buscando pósters y backdrops cruzados${apply ? '' : ' (dry-run: no se escribe nada)'}...`);

  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,release_date,poster,backdrop')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const crossed = rows.filter(r => {
    const p = imageFile(r.poster);
    return p && p === imageFile(r.backdrop);
  });
  console.log(`   ${crossed.length}/${rows.length} fichas con la misma imagen en poster y backdrop`);
  if (crossed.length === 0) return;

  const targets = Number.isFinite(limitArg) && (limitArg as number) > 0 ? crossed.slice(0, limitArg) : crossed;
  let fromTmdb = 0;
  let cleared = 0;
  let failed = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    const resolved = await Promise.all(chunk.map(async row => {
      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
      try {
        // Una ficha ya emparejada conserva su id; una sintética se vuelve a resolver
        // (el matcher ya sabe reconocer títulos regionales).
        let tmdbId = row.tmdb_id > 0 ? row.tmdb_id : 0;
        if (!tmdbId) {
          const year = String(row.release_date || '').slice(0, 4) || sourceTitleFromId(row.id).year;
          const match = await TmdbService.resolveTmdb(row.title, type, year || undefined, row.id);
          if (match.matched && match.id > 0) tmdbId = match.id;
        }
        const details = tmdbId ? await TmdbService.getTmdbDetails(tmdbId, type) : null;
        return { row, details };
      } catch {
        return { row, details: null };
      }
    }));

    for (const { row, details } of resolved) {
      const patch: Record<string, unknown> = {};

      if (details?.poster_path || details?.backdrop_path) {
        if (details.poster_path) patch.poster = `https://image.tmdb.org/t/p/w500${details.poster_path}`;
        // Solo se escribe el backdrop si TMDB tiene uno DE VERDAD; si no, se vacía para no
        // dejar el póster vertical haciendo de fondo apaisado.
        patch.backdrop = details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null;
        console.log(`   ✓ ${row.id}\n     "${row.title}" → imágenes oficiales de TMDB${details.backdrop_path ? '' : ' (sin backdrop en TMDB: se vacía)'}`);
        if (apply) {
          const { error } = await db.from('media_items').update(patch).eq('id', row.id);
          if (error) { console.warn(`     ⚠ ${error.message}`); failed++; continue; }
        }
        fromTmdb++;
        continue;
      }

      patch.backdrop = null;
      console.log(`   ␡ ${row.id}\n     "${row.title}" sin ficha en TMDB: se conserva el póster y se vacía el backdrop duplicado`);
      if (apply) {
        const { error } = await db.from('media_items').update(patch).eq('id', row.id);
        if (error) { console.warn(`     ⚠ ${error.message}`); failed++; continue; }
      }
      cleared++;
    }
  }

  console.log(
    `\n${apply ? '✅ Imágenes reparadas' : '📋 Dry-run'}: ${fromTmdb} ${apply ? 'tomaron' : 'tomarían'} las imágenes oficiales de TMDB, ` +
    `${cleared} ${apply ? 'conservan' : 'conservarían'} el póster con el backdrop vaciado, ${failed} fallidas`
  );
  if (!apply && (fromTmdb > 0 || cleared > 0)) console.log('   Ejecuta de nuevo con --apply para escribir los cambios.');
}

async function main() {
  const apply = process.argv.includes('--apply');
  // Elimina las filas duplicadas cuya versión correcta ya existe en el catálogo.
  const dedupe = process.argv.includes('--dedupe');
  // Re-visita la página de origen de cada ficha sospechosa para recuperar el título original
  // real y el og:image de TMDB, y re-fijar la ficha correcta (reparación total). Cuesta una
  // petición por ficha, por eso es opt-in; acótalo con --limit=N si el conjunto es grande.
  const refetch = process.argv.includes('--refetch');
  const limitArg = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '', 10);

  if (process.argv.includes('--reindex')) {
    await reindexSearchKeys(apply);
    return;
  }

  if (process.argv.includes('--verify')) {
    await verifyAgainstSource(
      apply,
      Number.isFinite(limitArg) ? limitArg : undefined,
      process.argv.includes('--restart')
    );
    return;
  }

  if (process.argv.includes('--aliases')) {
    await backfillRegionalAliases(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--fuse')) {
    await fuseSyntheticDuplicates(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--posters')) {
    await repairCrossedImages(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--unfuse')) {
    await unfuseWrongMerges(apply);
    return;
  }

  console.log(`🔎 Analizando el catálogo${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const rows = await fetchAllRows();
  console.log(`   ${rows.length} filas leídas`);

  const suspicious = rows
    .map(row => {
      const { title, year } = sourceTitleFromId(row.id);
      return { row, sourceTitle: title, year };
    })
    .filter(c => isTrustworthySlug(c.row.id, c.sourceTitle) && !looksLikeSameTitle(c.sourceTitle, c.row));

  console.log(`   ${suspicious.length} fichas sospechosas (el título guardado no se parece al de la fuente)\n`);
  if (process.argv.includes('--list')) {
    for (const c of suspicious) console.log(`   · ${c.row.id}\n     "${c.row.title}" ← esperado algo como "${c.sourceTitle}"`);
    return;
  }
  if (suspicious.length === 0) return;

  const targets = Number.isFinite(limitArg) && limitArg > 0 ? suspicious.slice(0, limitArg) : suspicious;
  const withMetadataSource = await hasColumn('metadata_source');
  const withMultiSource = await hasColumn('source_urls');

  let fixed = 0;
  let confirmed = 0;
  let unresolved = 0;
  let collisions = 0;
  let keptStored = 0;
  let deleted = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    const results = await Promise.all(chunk.map(async ({ row, sourceTitle, year }) => {
      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
      try {
        let match = await TmdbService.resolveTmdb(sourceTitle, type, year, row.id);
        // --refetch es un FALLBACK DIRIGIDO: solo cuando el slug no basta (sin match o poco
        // fiable) se re-visita la página de origen a por el título original real + la imagen de
        // TMDB (independientes del match equivocado guardado) y se reintenta. Así la red solo se
        // toca en las filas difíciles, no en las que el slug ya resuelve con confianza.
        if (refetch && (!match.matched || match.score < 0.9)) {
          const signals = await refetchSourceSignals(row);
          if (signals && (signals.originalTitle || signals.imageHint || signals.year)) {
            // El año de la PÁGINA manda sobre el del slug: el slug no lo trae casi nunca y,
            // cuando lo trae, puede ser parte del título ("cherry-2000", "madrid-1987").
            const retry = await TmdbService.resolveTmdb(
              signals.title || sourceTitle, type, signals.year || year, row.id, signals
            );
            if (retry.matched && retry.score >= match.score) match = retry;
          }
        }
        return { row, sourceTitle, year, type, match };
      } catch {
        return { row, sourceTitle, year, type, match: null };
      }
    }));

    for (const { row, sourceTitle, year, type, match } of results) {
      if (!match || !match.matched) {
        unresolved++;
        console.log(`   ? ${row.id}\n     guardado: "${row.title}" · sin match fiable para "${sourceTitle}" (se deja igual)`);
        continue;
      }
      if (match.id === row.tmdb_id) {
        confirmed++;
        continue;
      }

      // El tmdb_id es UNIQUE: si ya lo ocupa otra fila, esta fila es un DUPLICADO cuya
      // gemela correcta ya está en el catálogo (p. ej. "…gen-v-todas-las-temporadas…"
      // guardada como "Løbeklubben" frente a "fc-gen-v" = "Gen V"). Corregirla rompería el
      // índice, así que con --dedupe se elimina la copia rota y se conserva la buena.
      const { data: clash } = await db
        .from('media_items')
        .select(withMultiSource
          ? 'id,title,original_title,release_date,aliases,source_url,source_urls'
          : 'id,title,original_title,release_date,aliases,source_url')
        .eq('tmdb_id', match.id)
        .neq('id', row.id)
        .limit(1);

      if (clash && clash.length > 0) {
        const twin: any = clash[0];
        // Solo se borra si la gemela es INEQUÍVOCAMENTE el mismo título: parecido muy alto
        // y sin números de secuela discordantes ("cambio de bebés" vs "cambio de bebés 2"
        // son películas distintas, no un duplicado).
        const twinIsCorrect = isSameTitleStrict(sourceTitle, twin, year);

        if (dedupe && twinIsCorrect) {
          // SIN PÉRDIDAS: lo único que la copia rota aporta son su(s) página(s) de origen
          // (sus servidores, a menudo de OTRA fuente distinta a la de la gemela) y su nombre.
          // Se vuelcan en la ficha canónica ANTES de borrar, igual que hace --fuse; si no, se
          // perderían enlaces de streaming al eliminar la fila.
          const currentUrls: string[] = twin.source_urls || [];
          const mergedUrls = Array.from(
            new Set([...currentUrls, twin.source_url, row.source_url].filter(Boolean) as string[])
          );
          const currentAliases: string[] = twin.aliases || [];
          const mergedAliases = Array.from(
            new Set([...currentAliases, ...(row.aliases || []), row.title].filter(Boolean) as string[])
          );
          const patch: Record<string, unknown> = {};
          if (withMultiSource && mergedUrls.length > currentUrls.length) patch.source_urls = mergedUrls;
          if (mergedAliases.length > currentAliases.length) {
            patch.aliases = mergedAliases;
            patch.title_normalized = searchIndexKey(twin.title, twin.original_title, mergedAliases);
          }

          if (apply) {
            if (Object.keys(patch).length > 0) {
              const { error: mergeErr } = await db.from('media_items').update(patch).eq('id', twin.id);
              if (mergeErr) {
                console.warn(`     ⚠ no se pudo enriquecer la gemela ${twin.id}: ${mergeErr.message} (no se borra el duplicado)`);
                collisions++;
                continue;
              }
            }
            const { error } = await db.from('media_items').delete().eq('id', row.id);
            if (error) {
              console.warn(`     ⚠ no se pudo borrar ${row.id}: ${error.message}`);
              collisions++;
              continue;
            }
          }
          deleted++;
          console.log(`   ␡ ${row.id}\n     duplicado roto "${row.title}" fundido en ${twin.id} = "${twin.title}" y eliminado (fuentes ${currentUrls.length}→${mergedUrls.length}, alias ${currentAliases.length}→${mergedAliases.length})`);
          continue;
        }

        collisions++;
        console.log(`   ! ${row.id}\n     "${row.title}" → tmdb ${match.id} ya lo usa ${twin.id} = "${twin.title}"${dedupe ? ' (la gemela no confirma el título: se deja igual)' : ' (usa --dedupe para eliminar el duplicado roto)'}`);
        continue;
      }

      // Un título parecido no basta para sustituir una ficha: hay pares en los que la
      // guardada era la correcta y la candidata es una parodia o un homónimo oscuro. Se
      // exige que la candidata gane por título casi exacto O por respaldo de público
      // (más votos en TMDB que la ficha actual), que es justo lo que distingue
      // "Avengers 2: Era de Ultrón" (24.630 votos) de "Vengadores Chiflados" (1 voto).
      const [newDetails, oldDetails] = await Promise.all([
        TmdbService.getTmdbDetails(match.id, type).catch(() => null),
        row.tmdb_id > 0 ? TmdbService.getTmdbDetails(row.tmdb_id, type).catch(() => null) : Promise.resolve(null)
      ]);
      const newVotes = newDetails?.vote_count || 0;
      const oldVotes = oldDetails?.vote_count || 0;

      if (match.score < 0.9 && newVotes <= oldVotes) {
        keptStored++;
        console.log(`   = ${row.id}\n     se conserva "${row.title}" (${oldVotes} votos) frente a "${newDetails?.title || newDetails?.name || match.id}" (${newVotes} votos)`);
        continue;
      }

      // Ficha nueva completa: se re-enriquece partiendo del título REAL de la fuente.
      const base: MediaItem = {
        id: row.id,
        tmdb_id: match.id,
        imdb_id: null,
        type,
        title: sourceTitle,
        original_title: sourceTitle,
        aliases: [sourceTitle],
        overview: '',
        rating: 0,
        release_date: year || row.release_date || '',
        genres: [],
        subcategories: [],
        poster: null,
        backdrop: null,
        logo: null,
        trailer: null,
        cast: [],
        dubbing_cast: []
      };

      const enriched = await TmdbService.enrichMediaItem(base, { skipSeasons: true });

      console.log(`   ✓ ${row.id}\n     "${row.title}" → "${enriched.title}" (tmdb ${row.tmdb_id} → ${enriched.tmdb_id}, score ${match.score.toFixed(2)})`);

      if (!apply) {
        fixed++;
        continue;
      }

      const update: Record<string, unknown> = {
        tmdb_id: enriched.tmdb_id,
        type: enriched.type,
        title: enriched.title,
        original_title: enriched.original_title || enriched.title,
        title_normalized: searchIndexKey(enriched.title, enriched.original_title, enriched.aliases),
        aliases: enriched.aliases || [],
        tagline: enriched.tagline || '',
        overview: enriched.overview || '',
        rating: enriched.rating || 0,
        content_rating: enriched.content_rating || null,
        release_date: enriched.release_date || '',
        genres: enriched.genres || [],
        poster: enriched.poster,
        backdrop: enriched.backdrop,
        logo: enriched.logo,
        trailer: enriched.trailer,
        cast_data: (enriched.cast_details && enriched.cast_details.length ? enriched.cast_details : enriched.cast) || [],
        total_seasons: enriched.total_seasons || 0,
        total_episodes: enriched.total_episodes || 0,
        updated_at: new Date().toISOString()
      };
      if (withMetadataSource) update.metadata_source = enriched.metadata_source || 'tmdb';

      const { error } = await db.from('media_items').update(update).eq('id', row.id);
      if (error) {
        console.warn(`     ⚠ no se pudo guardar: ${error.message}`);
      } else {
        fixed++;
      }
    }
  }

  console.log(
    `\n${apply ? '✅ Reparación aplicada' : '📋 Dry-run'}: ${fixed} fichas ${apply ? 'corregidas' : 'a corregir'}, ` +
    `${confirmed} ya correctas, ${keptStored} conservadas (la candidata no era mejor), ` +
    `${deleted} duplicados ${apply ? 'eliminados' : 'a eliminar'}, ` +
    `${unresolved} sin match fiable, ${collisions} bloqueadas por tmdb_id duplicado`
  );
  if (!apply && fixed > 0) console.log('   Ejecuta de nuevo con --apply para escribir los cambios.');
}

/**
 * Cierre del proceso. Supabase deja sockets HTTP cerrándose; llamar a process.exit() en el
 * mismo turno del bucle de eventos aborta libuv en Windows ("UV_HANDLE_CLOSING") y convierte
 * una ejecución correcta en un fallo — se ve en cuanto un modo termina rápido, como --fuse
 * sin la migración aplicada. El timer sin ref no retiene el proceso: si el bucle se vacía
 * antes, sale solo con este código; si algo lo mantiene vivo, fuerza la salida.
 */
function exitWhenSettled(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 250).unref();
}

main()
  .then(() => exitWhenSettled(0))
  .catch(err => {
    console.error('❌ repairCatalog:', err);
    exitWhenSettled(1);
  });
