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
 *   npm run repair:catalog -- --fuentes           # informa de fichas que sacan servidores de la
 *                                                 # página de OTRA película (homónimos)
 *   npm run repair:catalog -- --fuentes --apply   # retira esas fuentes y vacía sus enlaces
 *   npm run repair:catalog -- --purgar-cache --apply
 *                                                 # retira del caché las fichas cambiadas en 24 h
 *                                                 # (necesita las credenciales del caché)
 *   npm run repair:catalog -- --purgar-cache --apply --fantasmas
 *                                                 # busca en el CACHÉ fichas que ya no están en
 *                                                 # la base y las retira (no depende de logs)
 *   npm run repair:catalog -- --purgar-cache --apply --ids=a,b
 *                                                 # por id: para fichas ya BORRADAS, cuya entrada
 *                                                 # de caché seguiría respondiendo 200
 *   npm run repair:catalog -- --reindex --apply   # reconstruye title_normalized
 *   npm run repair:catalog -- --aliases           # informa de títulos regionales que faltan
 *   npm run repair:catalog -- --aliases --apply   # añade los nombres regionales de TMDB a aliases
 *   npm run repair:catalog -- --verify            # repasa TODAS las fichas contra su página de
 *                                                 # origen (og:image + año + título original)
 *   npm run repair:catalog -- --verify --apply    # …y corrige/funde las que estén mal
 *   npm run repair:catalog -- --verify --restart  # ignora el punto de guardado y empieza de cero
 *   npm run repair:catalog -- --verify --apply --ids=a,b,c
 *                                                 # solo esas fichas (para volver sobre las que
 *                                                 # quedaron pendientes de algo)
 *   npm run repair:catalog -- --verify --apply --tipos
 *                                                 # solo las fichas cuya clase (película/serie)
 *                                                 # contradice a su fuente
 *   npm run repair:catalog -- --verify --apply --rotar --limit=N
 *                                                 # tanda de N elegida por la FECHA, sin punto de
 *                                                 # guardado: barre el catálogo entero en bucle
 *                                                 # (es la que corre sola cada día en el workflow)
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
import { TmdbService, tmdbImagePath, OTRO_ALFABETO, similarity as tmdbSimilarity } from '../src/services/tmdbService';
import { RealScraperService, SourceSignals } from '../src/services/realScraperService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, normalizeTitle, searchIndexKey, dedupeTitles, sourceTitleFromSlug, slugify } from '../src/utils/text';
// La puerta de identidad de las fuentes vive en catalogService: el script y la API tienen que
// decidir lo MISMO sobre qué página pertenece a qué ficha.
import { CatalogService, esPaginaPropia, candidateIdsForUrl, tipoDeLaRuta } from '../src/services/catalogService';
import { CacheStore } from '../src/cache/store';
import { inspectEmbed } from '../src/scrapers/embedHealth';
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
    // Idénticos y ya está. Hace falta decirlo aparte porque las dos similitudes comparan sobre
    // la clave canónica, que se queda VACÍA en alfabetos no latinos y entonces puntúa 0: el
    // original coreano "앵커" no se reconocía ni comparándolo consigo mismo.
    mismoTituloLiteral(sourceTitle, c) ||
    similarity(sourceTitle, c) >= SUSPICIOUS_BELOW ||
    charSimilarity(sourceTitle, c) >= CHAR_SIMILARITY_BELOW
  );
}

/** Mismo título letra por letra, sin acentos ni dobles espacios. Conserva el alfabeto. */
function mismoTituloLiteral(a: string, b: string): boolean {
  const k = (t: string) => normalizeTitle(t).replace(/\s+/g, ' ').trim();
  return !!k(a) && k(a) === k(b);
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
      marcarTocada(p);
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
        marcarTocada(row);
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
        .select('id,title,original_title,aliases,release_date,source_url,source_urls')
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

      // Tercera llave: la época. Un remake registra en TMDB los mismos nombres que el original
      // —los confirma la llave anterior sin pestañear— y aun así es otra película con otros
      // servidores. Con el año en la mano no hay que suponer nada.
      const twinYear = Number(String(twin.release_date || '').slice(0, 4)) || Number(sourceTitleFromId(twin.id).year) || 0;
      const rowYear = Number(year) || 0;
      if (rowYear && twinYear && Math.abs(rowYear - twinYear) > 1) {
        skipped++;
        console.log(`   ! ${row.id}\n     "${row.title}" (${rowYear}) ~ ${twin.id} = "${twin.title}" (${twinYear}): mismo nombre, otra época — no se funde`);
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
          marcarTocada(twin);
          const { error } = await db.from('media_items').update(patch).eq('id', twin.id);
          if (error) {
            console.warn(`     ⚠ no se pudo enriquecer la ficha canónica: ${error.message} (no se borra el duplicado)`);
            skipped++;
            continue;
          }
        }
        marcarTocada(row);
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
    // El og:image de la página vale dos veces: confirma el candidato de TMDB (es la ruta de una
    // ficha concreta) y, si al final no hay match, se queda como póster de la ficha — de la
    // fuente, pero suyo.
    poster: signals.imageHint || null,
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

  marcarTocada(row);
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
 *
 * Es el ÚNICO sitio del script por el que las fuentes de una fila pasan a otra, así que aquí se
 * pone la última reja: si las dos fichas no son de la misma época, no son la misma obra y no se
 * funde nada, diga lo que diga el tmdb_id. Cuesta poco y cierra la vía por la que una película
 * termina sirviendo el vídeo de otra.
 */
async function fuseRowInto(
  row: any,
  twin: any,
  extraAliases: string[],
  opts: { apply: boolean; withMultiSource: boolean; sourceYear?: string }
): Promise<{ ok: boolean; urls: [number, number]; aliases: [number, number]; rechazada?: string }> {
  // El año de la fila se toma de su PÁGINA de origen, no de `release_date`.
  //
  // Aquí se llega porque la página confirmó que la fila es la ficha que ya tiene la gemela, así
  // que lo guardado es justo el dato en duda: en una fila mal emparejada `release_date` es el de
  // la película equivocada. Comparando eso, la reja rechazaba dedupes legítimos —el pack
  // "One Piece Todas Las Temporadas" estaba guardado como "ONE PIECE BONUS CONTENT" (2026) y no
  // se dejaba fundir con "ONE PIECE" (2023), que es lo que es—.
  const yearA = Number(opts.sourceYear)
    || Number(String(row.release_date || '').slice(0, 4))
    || Number(sourceTitleFromId(row.id).year) || 0;
  const yearB = Number(String(twin.release_date || '').slice(0, 4)) || Number(sourceTitleFromId(twin.id).year) || 0;
  if (yearA && yearB && Math.abs(yearA - yearB) > 1) {
    return {
      ok: false,
      urls: [0, 0],
      aliases: [0, 0],
      rechazada: `"${row.title}" (${yearA}) y "${twin.title}" (${yearB}) no son de la misma época`
    };
  }

  const currentUrls: string[] = twin.source_urls || [];
  const mergedUrls = Array.from(new Set(
    [...currentUrls, twin.source_url, ...(row.source_urls || []), row.source_url].filter(Boolean) as string[]
  ));
  // Del duplicado se absorben sus FUENTES y el nombre que publica su PÁGINA (`extraAliases`), pero
  // NO su título ni sus alias guardados: aquí se llega justamente porque su tmdb_id era el de otra
  // obra, así que esos nombres son de esa otra obra. Absorbiéndolos, la ficha buena quedaba
  // indexada por el nombre ajeno —"Eric" (la miniserie) respondía a "Eric André Live Near
  // Broadway"— y la búsqueda devolvía una cosa cuando le pedías otra.
  const currentAliases: string[] = twin.aliases || [];
  const mergedAliases = dedupeTitles([...currentAliases, ...extraAliases]);

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
    marcarTocada(twin);
    const { error } = await db.from('media_items').update(patch).eq('id', twin.id);
    if (error) {
      console.warn(`     ⚠ no se pudo enriquecer ${twin.id}: ${error.message} (no se borra el duplicado)`);
      return { ok: false, ...sizes };
    }
  }
  marcarTocada(row);
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
      ? 'id,type,title,original_title,aliases,release_date,source_url,source_urls'
      : 'id,type,title,original_title,aliases,release_date,source_url')
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
    const merged = await fuseRowInto(twin, owner, [signals.title], { ...opts, sourceYear: signals.year });
    if (merged.rechazada) return { freed: false, reason: `no se funde: ${merged.rechazada}` };
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

/**
 * Fichas cuya fila se ha modificado. Al terminar se retiran del CACHÉ.
 *
 * Sin esto una reparación no se nota: la metadata se cachea 6 h y, con Redis compartido, las claves
 * sobreviven incluso a un redespliegue. O sea que la ficha corregida sigue sirviendo el póster, la
 * sinopsis o los alias viejos durante horas y el arreglo parece no haber servido de nada — pasó con
 * "Eric", que ya estaba bien en la base de datos y la API seguía devolviendo el alias ajeno.
 *
 * Se marca ANTES de escribir y con los datos VIEJOS de la fila, que es con lo que se construyeron
 * las claves. Marcar una fila cuya escritura luego falle no hace daño: se relee de la base.
 */
const tocadas: Array<{ id: string; tmdb_id?: number }> = [];

function marcarTocada(row: any): void {
  if (row && row.id) tocadas.push({ id: String(row.id), tmdb_id: row.tmdb_id });
}

/** Retira del caché todo lo que se haya tocado. Se llama una vez, al final. */
async function purgarCacheDeTocadas(apply: boolean): Promise<void> {
  if (!apply || tocadas.length === 0) return;
  const vistas = new Set<string>();
  const unicas = tocadas.filter(t => (vistas.has(t.id) ? false : (vistas.add(t.id), true)));
  const claves = unicas.flatMap(t => CatalogService.cacheKeysFor(t));
  const TANDA = 400;
  for (let i = 0; i < claves.length; i += TANDA) await CacheStore.del(...claves.slice(i, i + TANDA));

  // Y las listas: los datos de la ficha viven además COPIADOS dentro de los resultados de búsqueda
  // y de los carruseles del home. Sin esto, la ficha queda arreglada pero la búsqueda —por donde
  // la ve quien usa la app— la sigue enseñando rota.
  await CatalogService.invalidateListings();
  console.log(
    `
🧹 ${unicas.length} ficha(s) retiradas del caché` +
    (CacheStore.isShared() ? ' (Redis compartido)' : ' (solo memoria local: en producción caducan por TTL)')
  );
}

/**
 * PURGA DE CACHÉ (`--purgar-cache`).
 *
 * Retira del caché las fichas modificadas recientemente, para que un arreglo se note YA. Existe
 * porque la metadata se cachea 6 h y, con Redis compartido, las claves sobreviven a los
 * despliegues: sin esto una reparación tarda horas en verse y parece no haber funcionado.
 *
 * Los modos de reparación ya purgan lo que tocan. Esto es para arreglos hechos ANTES de que eso
 * existiera, o hechos a mano en el SQL Editor.
 *
 *   npm run repair:catalog -- --purgar-cache --apply             # las tocadas en las últimas 24 h
 *   npm run repair:catalog -- --purgar-cache --apply --desde=12  # en las últimas 12 h
 *
 * OJO: para que llegue al Redis de PRODUCCIÓN, el proceso necesita las credenciales del caché
 * (`KV_REST_API_URL` + `KV_REST_API_TOKEN`, o el par `UPSTASH_REDIS_REST_*`). Sin ellas solo limpia
 * la memoria de este proceso, que no le sirve a nadie: el propio comando lo avisa.
 */
async function purgeRecentlyChanged(apply: boolean, horas: number, ids?: string[]): Promise<void> {
  const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
  console.log(ids && ids.length
    ? `🧹 Purgando del caché ${ids.length} ficha(s) por id...`
    : `🧹 Purgando del caché las fichas modificadas desde ${desde}...`);

  if (!CacheStore.isShared()) {
    console.warn('   ⚠ Sin credenciales de caché en el entorno: esto NO alcanza al Redis de producción.');
    console.warn('     Exporta KV_REST_API_URL y KV_REST_API_TOKEN (los tiene el proyecto en Vercel) y repite.');
  }

  const filas: any[] = [];

  if (ids && ids.length > 0) {
    /**
     * Purga por ID, para fichas que YA NO EXISTEN.
     *
     * Cuando una reparación funde un duplicado, borra su fila — pero su entrada de caché sigue
     * viva, y entonces ese id responde 200 con la metadata de la obra equivocada durante horas.
     * Al no estar en la tabla, no hay consulta que las encuentre: hay que nombrarlas. Los ids
     * salen del log de la reparación (las líneas ⇄ y ␡).
     *
     * Sin fila no se conoce su tmdb_id, así que se purgan las claves que dependen del id. Las que
     * dependían del número las cubre la purga por fecha de la ficha que la absorbió.
     */
    for (const id of ids) filas.push({ id });
  } else {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from('media_items')
        .select('id,tmdb_id,type,title,updated_at')
        .gte('updated_at', desde)
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      filas.push(...data);
      if (data.length < 1000) break;
    }
    console.log(`   ${filas.length} fichas modificadas en ese plazo`);
  }
  if (!apply) {
    console.log('   (dry-run: no se ha borrado ninguna clave. Repite con --apply)');
    return;
  }

  // Las claves se juntan y se borran en tandas grandes: cada llamada a `del` es una petición de
  // red, y una por ficha son decenas de miles — suficiente para agotar la cuota del plan gratuito.
  const claves = filas.flatMap(f => CatalogService.cacheKeysFor(f));
  const TANDA = 400;
  for (let i = 0; i < claves.length; i += TANDA) {
    await CacheStore.del(...claves.slice(i, i + TANDA));
    console.log(`   ...${Math.min(i + TANDA, claves.length)}/${claves.length} claves`);
  }
  await CatalogService.invalidateListings();
  console.log(`   ✅ ${filas.length} fichas retiradas del caché (${claves.length} claves en ${Math.ceil(claves.length / TANDA)} peticiones) + listas y búsquedas`);
}

/**
 * PURGA DE ENTRADAS HUÉRFANAS (`--purgar-cache --fantasmas`).
 *
 * Una reparación que funde un duplicado BORRA su fila, pero su entrada de caché sigue viva: ese id
 * responde 200 con la metadata de la obra equivocada hasta que caduque (6 h), y al no estar en la
 * tabla no hay consulta a la base que la encuentre. Tirar de la lista del log tampoco vale — basta
 * con que una pasada no dejara log para que su ficha se quede fuera, que es justo lo que pasó con
 * `2026-01-eric-2024-html`.
 *
 * Así que se le pregunta al CACHÉ qué tiene guardado y se comprueba contra la base. Lo que ya no
 * existe, fuera. Es la comprobación que no depende de acordarse de nada.
 */
async function purgeGhostCacheEntries(apply: boolean): Promise<void> {
  console.log(`👻 Buscando entradas de caché de fichas que ya no existen${apply ? '' : ' (dry-run)'}...`);

  if (!CacheStore.isShared()) {
    console.warn('   ⚠ Sin credenciales de caché: esto no alcanza al Redis de producción.');
    return;
  }

  const claves = await CacheStore.keys('*');
  console.log(`   ${claves.length} claves en el caché`);

  // Solo las de ficha (`meta:<id>` / `byid:<id>`), quitando el sufijo de tipo.
  const porId = new Map<string, string[]>();
  for (const k of claves) {
    const m = k.match(/^(?:meta|byid):(.+)$/);
    if (!m) continue;
    const id = m[1].replace(/:(movie|tvseries)$/, '');
    if (!id || /^-?\d+$/.test(id)) continue;   // las numéricas son por tmdb_id, no por slug
    porId.set(id, [...(porId.get(id) || []), k]);
  }
  console.log(`   ${porId.size} fichas distintas cacheadas por su id`);
  if (porId.size === 0) return;

  const ids = Array.from(porId.keys());
  const vivos = new Set<string>();
  const TANDA = 200;
  for (let i = 0; i < ids.length; i += TANDA) {
    const { data } = await db.from('media_items').select('id').in('id', ids.slice(i, i + TANDA));
    for (const r of (data || []) as any[]) vivos.add(String(r.id));
  }

  const fantasmas = ids.filter(id => !vivos.has(id));
  if (fantasmas.length === 0) {
    console.log('   ✅ ninguna entrada huérfana');
    return;
  }

  console.log(`   ${fantasmas.length} ficha(s) cacheadas que ya NO están en la base:`);
  for (const id of fantasmas) console.log(`      ␡ ${id}`);
  if (!apply) {
    console.log('   (dry-run: repite con --apply)');
    return;
  }

  const aBorrar = fantasmas.flatMap(id => porId.get(id) || []);
  await CacheStore.del(...aBorrar);
  console.log(`   ✅ ${aBorrar.length} claves borradas`);
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

async function verifyAgainstSource(
  apply: boolean,
  limitArg?: number,
  restart = false,
  rotar = false,
  soloTipos = false,
  soloIds?: string[]
): Promise<void> {
  console.log(`🔬 Verificando fichas contra su página de origen${apply ? '' : ' (dry-run: no se escribe nada)'}...`);

  const withMultiSource = await hasColumn('source_urls');
  const withMetadataSource = await hasColumn('metadata_source');

  // Con `--rotar` no se usa el punto de guardado: la tanda la elige la FECHA (ver abajo), que es
  // un estado que no hay que guardar en ninguna parte.
  const checkpoint = verifyCheckpointFile(apply);
  const done = rotar ? new Set<string>() : loadCheckpoint(checkpoint, restart);
  if (done.size > 0) console.log(`   ↻ reanudando: ${done.size} fichas ya repasadas (usa --restart para empezar de cero)`);

  const extraColumns = [
    ...(withMultiSource ? ['source_urls'] : []),
    ...(withMetadataSource ? ['metadata_source'] : [])
  ];
  let rows = (await fetchAllRows(extraColumns))
    .filter(row => sourceUrlOf(row) && !done.has(row.id));

  // `--ids=a,b,c`: repasar unas fichas concretas. Sirve para volver sobre las que quedaron
  // pendientes de algo (una migración, un arreglo del matcher) sin pagar el catálogo entero.
  if (soloIds && soloIds.length > 0) {
    const pedidas = new Set(soloIds);
    rows = rows.filter(row => pedidas.has(String(row.id)));
    console.log(`   ${rows.length}/${soloIds.length} de las fichas pedidas tienen página de origen`);
  }

  // `--tipos`: solo las fichas cuya CLASE contradice a su fuente (una página de `/pelicula/`
  // guardada como serie, o al revés). Es el residuo que deja un emparejado que cruzó de catálogo,
  // y sale de una comprobación gratis, así que se puede repasar en minutos en vez de en una hora.
  if (soloTipos) {
    rows = rows.filter(row => {
      const t = tipoDeLaRuta(sourceUrlOf(row));
      return !!t && t !== (row.type === 'tvseries' ? 'tvseries' : 'movie');
    });
    console.log(`   ${rows.length} fichas cuya clase (película/serie) contradice a su fuente`);
  }

  let targets = Number.isFinite(limitArg) && (limitArg as number) > 0 ? rows.slice(0, limitArg) : rows;

  /**
   * VENTANA ROTATORIA (`--rotar`) — para que el repaso avance solo, día tras día, sin estado.
   *
   * El punto de guardado es un archivo local, así que en un runner de CI se pierde en cada
   * corrida: sin esto, la tarea diaria repasaría eternamente las MISMAS primeras N fichas y el
   * resto del catálogo no se revisaría nunca. Con la ventana rotatoria la tanda se deriva del
   * día, sobre las filas ordenadas por id: la cobertura completa llega sola cada
   * ceil(total/N) días y se repite en bucle, que es exactamente lo que se quiere de una
   * comprobación que hay que seguir haciendo para siempre (las fuentes cambian sus páginas).
   */
  if (rotar && Number.isFinite(limitArg) && (limitArg as number) > 0) {
    const lote = limitArg as number;
    const ordenadas = rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const dias = Math.floor(Date.now() / 86400000);
    const vueltas = Math.max(1, Math.ceil(ordenadas.length / lote));
    const desde = (dias % vueltas) * lote;
    targets = ordenadas.slice(desde, desde + lote);
    console.log(`   ventana rotatoria: fichas ${desde}–${desde + targets.length} de ${ordenadas.length} (vuelta completa cada ${vueltas} días)`);
  }

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
      const signals = await refetchSourceSignals(row);
      // El tipo lo dice la FUENTE, no la columna: si un emparejado cruzó de catálogo, `type` ya
      // está mal y verificar con él vuelve a confirmar el error en cada pasada. Lo declara la
      // propia ficha de datos de la página (FuegoCine publica sus temporadas y episodios) y, si
      // no, la categoría de la ruta (`/pelicula/` frente a `/serie/` en TioPlus).
      const type: ContentType = signals?.type
        || tipoDeLaRuta(sourceUrlOf(row))
        || (row.type === 'tvseries' ? 'tvseries' : 'movie');
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
        // Ni que esté ROTULADA de forma legible: TMDB devuelve el título original cuando no tiene
        // traducción al español, así que la ficha puede quedar escrita en coreano, japonés o
        // cirílico. La página de origen publica un nombre que sí se puede leer, y el id no cambia.
        if (OTRO_ALFABETO.test(row.title || '') && !OTRO_ALFABETO.test(signals.title)) {
          const rerotulada = await rewriteRowFromMatch(row, type, row.tmdb_id, signals, { apply, withMetadataSource });
          if (rerotulada.title) {
            console.log(`   ✓ ${row.id}\n     "${row.title}" estaba rotulada en otro alfabeto → "${rerotulada.title}" (confirmada por imagen, mismo tmdb ${row.tmdb_id})`);
            fixed++;
            continue;
          }
        }

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
        /**
         * El id es el bueno, pero el RÓTULO puede no serlo: cuando TMDB no tiene traducción al
         * español devuelve el título original, y la ficha queda escrita en coreano, japonés o
         * cirílico en una API que sirve en español. La página de origen sí publica un nombre
         * legible, así que se reescribe desde ella conservando el mismo tmdb_id.
         */
        if (OTRO_ALFABETO.test(row.title || '') && !OTRO_ALFABETO.test(signals.title)) {
          const rerotulada = await rewriteRowFromMatch(row, type, row.tmdb_id, signals, { apply, withMetadataSource });
          if (rerotulada.title) {
            fixed++;
            console.log(`   ✓ ${row.id}
     "${row.title}" estaba rotulada en otro alfabeto → "${rerotulada.title}" (mismo tmdb ${row.tmdb_id})`);
            continue;
          }
        }

        okRematch++;
        continue;
      }

      // Un id distinto SIN respaldo no autoriza a escribir: podría ser el matcher acertando de
      // menos, y sustituir una ficha buena por otra es exactamente el daño que se quiere evitar.
      if (!match.verified) {
        /**
         * Con UNA excepción: que la clase de la ficha contradiga a su fuente.
         *
         * Si la página es de `/pelicula/` y la fila está guardada como serie, la ficha NO es de
         * esa obra — da igual lo que diga el parecido del título. Pasa cuando el emparejado cruza
         * de catálogo: TMDB registra "Die Hart 2: Die Harter", que es una película de 2024, como
         * título alternativo de la SERIE "Die Hart" (2020), y la ficha se quedó con el póster, la
         * sinopsis y las temporadas de la serie.
         *
         * Aquí no se puede "dejar igual", porque lo que hay guardado ya es de otra obra. Se
         * reconstruye desde la página con `tmdbId = 0`, o sea dejando que el emparejado decida de
         * cero con el tipo correcto: si algo lo respalda, la ficha buena; y si no, la metadata de
         * su propia fuente. Un póster peor pero SUYO, que es la regla de toda la casa.
         */
        const claseGuardada: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
        if (type !== claseGuardada) {
          const reset = await rewriteRowFromMatch(row, type, 0, signals, { apply, withMetadataSource });
          if (reset.title) {
            fixed++;
            console.log(
              `   ✓ ${row.id}\n     "${row.title}" estaba guardada como ${claseGuardada === 'tvseries' ? 'serie' : 'película'}` +
              ` pero su fuente publica ${type === 'tvseries' ? 'una serie' : 'una película'} → se reconstruye desde la página: "${reset.title}"`
            );
            continue;
          }
        }

        doubtful++;
        console.log(`   ~ ${row.id}\n     "${row.title}" (tmdb ${row.tmdb_id}) · la fuente sugiere tmdb ${match.id} pero sin respaldo (score ${match.score.toFixed(2)}): solo se informa`);
        continue;
      }

      const clashColumns = withMultiSource
        ? 'id,tmdb_id,type,title,original_title,aliases,release_date,source_url,source_urls'
        : 'id,tmdb_id,type,title,original_title,aliases,release_date,source_url';
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
        const merged = await fuseRowInto(row, twin, [signals.title], { apply, withMultiSource, sourceYear: signals.year });
        if (merged.rechazada) {
          blocked++;
          console.log(`   ! ${row.id}\n     comparte tmdb ${match.id} con ${twin.id} pero NO se funde: ${merged.rechazada}`);
          continue;
        }
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
      .select('id,tmdb_id,type,title,original_title,release_date,aliases,source_urls,source_url')
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
      const year = String(row.release_date || '').slice(0, 4) || sourceTitleFromId(row.id).year || undefined;
      const ajenos: Array<{ alias: string; deQuien: string }> = [];

      for (const alias of row.aliases || []) {
        // 0. Es el nombre con el que la FUENTE publicó esta ficha: intocable. Se reconoce porque el
        //    id de la fila ES el slug de su página, así que el alias aparece dentro. Sin esto se le
        //    retiraba "Furia" a la fila `furia` y "Abismo" a la fila `abismo` —los nombres que ve
        //    quien usa la web— solo porque TMDB rotula esas fichas con su título original.
        const slugAlias = slugify(alias);
        if (slugAlias.length >= 4 && String(row.id).includes(slugAlias)) continue;

        // 1. Se parece a como se llama la ficha: es suyo. Se usa la similitud del MATCHER, que sabe
        //    de alfabetos no latinos y de variantes de escritura; la local de este script no.
        if (tmdbSimilarity(alias, row.title) >= 0.6) continue;
        if (row.original_title && tmdbSimilarity(alias, row.original_title) >= 0.6) continue;

        // 2. TMDB lo registra para esta ficha: es uno de sus nombres regionales.
        const suyo = await TmdbService.confirmsTitle(row.tmdb_id, type, alias).catch(() => true);
        if (suyo) continue;

        // 3. ¿De quién es, entonces? Solo se retira con PRUEBA doble: que TMDB resuelva ese nombre,
        //    con respaldo, a otra ficha, Y que esa otra ficha lo tenga REGISTRADO como nombre suyo.
        //    Lo segundo es imprescindible: resolver un alias suelto es tan falible como cualquier
        //    emparejado por título, y sin exigirlo se retiraba "The Tiger" de "Tiger: Tanque de
        //    guerra" alegando que pertenecía a "The Lost Tiger", que no lo lleva registrado.
        const otro = await TmdbService.resolveTmdb(alias, type, year, `unfuse:${row.id}:${alias}`).catch(() => null);
        if (!otro || !otro.matched || !otro.verified || otro.id === row.tmdb_id) continue;

        const registrado = await TmdbService.confirmsTitle(otro.id, otro.type, alias).catch(() => false);
        if (!registrado) continue;

        const ficha = await TmdbService.getTmdbDetails(otro.id, otro.type).catch(() => null);
        ajenos.push({ alias, deQuien: `"${ficha?.title || ficha?.name || otro.id}" (tmdb ${otro.id})` });
      }
      return { row, ajenos };
    }));

    for (const { row, ajenos } of checked) {
      if (ajenos.length === 0) continue;

      const fuera = ajenos.map(a => a.alias);
      const keptAliases = (row.aliases || []).filter((a: string) => !fuera.includes(a));
      // Ninguna ficha se queda sin nombres: al menos el suyo.
      if (keptAliases.length === 0) keptAliases.push(row.title);

      const patch: Record<string, unknown> = { aliases: keptAliases };
      if (withNormalized) patch.title_normalized = searchIndexKey(row.title, row.original_title, keptAliases);

      console.log(
        `   ␡ ${row.id} "${row.title}"\n` +
        ajenos.map(a => `     retira "${a.alias}" — ese nombre es de ${a.deQuien}`).join('\n')
      );

      if (apply) {
        marcarTocada(row);
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

/**
 * PURGA DE FUENTES INTRUSAS (`--fuentes`).
 *
 * `source_urls` es la lista de páginas de las que una ficha saca servidores, y la fusión
 * multifuente la rellenaba aceptando cualquier candidato que se LLAMARA igual. El catálogo está
 * lleno de homónimos exactos —"Sin salida" son cuatro películas distintas, "Carrie" tres— y el
 * título de la ficha es el de TMDB en español, el que más colisiona, así que fichas enteras
 * acabaron sirviendo los servidores de otra película. El caso medido: la ficha de "Sin salida"
 * (2024) llegó a listar como fuentes propias las páginas de Abduction (2011), Not Safe for Work
 * (2014), No Exit (2022) y The Firm (1993, que en es-MX se titula igual).
 *
 * La puerta de identidad de catalogService ya no lo permite, pero lo que se escribió sigue ahí.
 * Este modo interroga cada página de origen con las tres llaves que separan obras distintas:
 *
 *   0. el DUEÑO — que la página sea la de otra ficha del catálogo con distinto tmdb_id es prueba
 *      definitiva, y sale del propio catálogo sin gastar una petición. Es además la única llave
 *      que separa homónimos del MISMO año, donde la fecha no distingue nada ("El botín" son dos
 *      películas de 2026);
 *   1. el AÑO — destapa los homónimos de otra época, que son el caso masivo (una petición
 *      ligera por página: `fetchSourceSignals`, que no resuelve servidores);
 *   2. el NOMBRE — para lo que el año no separa (dos estrenos del mismo año). Comparar los
 *      títulos MOSTRADOS entre sí no vale: los nombres regionales de la misma película no se
 *      parecen ("En la tormenta" y "Sin salida" son las dos No Exit 2022; "Ella" es "Her"), y
 *      retirar una fuente legítima cuesta servidores reales. Se exige que no la respalde NADA:
 *      ni el título original que publica la página, ni el mostrado, ni TMDB, que registra los
 *      títulos alternativos y las traducciones de cada ficha.
 *
 * Solo se retira con PRUEBA. Si la página no dice su año y no hay tmdb_id con quien confirmar el
 * nombre, se conserva y se informa.
 *
 * Al quitar una fuente se borran también los `servers` de la ficha: un servidor no guarda de qué
 * página salió (`source_id` es el sitio, no la url), así que no se puede depurar la lista — se
 * vacía y la siguiente resolución la reconstruye desde las fuentes que sí son suyas.
 */
async function purgeIntruderSources(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`🧬 Revisando las fuentes de cada ficha${apply ? '' : ' (dry-run: no se escribe nada)'}...`);

  if (!(await hasColumn('source_urls'))) {
    console.warn('   ⚠ Columna source_urls ausente — ejecuta src/db/migrations/005_multisource_and_availability.sql.');
    return;
  }
  const withAvailability = await hasColumn('has_streams');

  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,original_title,release_date,source_url,source_urls')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  // Índice de "quién es el dueño de cada página", para la llave 0 (ver más abajo).
  const byId = new Map<string, any>(rows.map(r => [String(r.id), r]));
  const ownerOf = (url: string): any =>
    candidateIdsForUrl(url).map(c => byId.get(c)).find(Boolean);

  // Se revisa toda ficha con alguna fuente que NO sea su propia página. Suele ser una fusión
  // legítima (la misma película en las dos fuentes), pero es el único sitio donde puede haberse
  // colado la página de otra obra. Ojo: no basta con mirar las multifuente — una ficha puede
  // tener UNA sola url y que sea de otra película ("Moon Knight" apuntaba a la serie "Mo"), y ese
  // es justo el caso peor, porque entonces TODO lo que sirve es ajeno.
  const multi = rows.filter(r =>
    ((r.source_urls || []).filter(Boolean) as string[]).some(u => !esPaginaPropia(r.id, u, r.type === 'tvseries' ? 'tvseries' : 'movie'))
  );
  console.log(`   ${multi.length}/${rows.length} fichas con alguna fuente que no es su propia página`);

  const targets = Number.isFinite(limitArg) && (limitArg as number) > 0 ? multi.slice(0, limitArg) : multi;
  let depuradas = 0;
  let intrusasTotales = 0;
  let porDuenno = 0;
  let porAno = 0;
  let porNombre = 0;
  let sinAno = 0;

  const CONCURRENCY = 4;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);

    const revisadas = await Promise.all(chunk.map(async row => {
      const urls: string[] = Array.from(new Set((row.source_urls || []).filter(Boolean)));
      const fichaYear = Number(String(row.release_date || '').slice(0, 4)) || Number(sourceTitleFromId(row.id).year) || 0;

      const type: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';

      const veredictos = await Promise.all(urls.map(async url => {
        // La página de la que SALIÓ la ficha nunca se pone en duda: si algo no cuadra con ella,
        // el dato dudoso es el `release_date` guardado. Se reconoce por el id de la fila, que ES
        // el slug de su fuente, y no por el título —comparar títulos es justo lo que confunde
        // homónimos: `carrie-2002` no debe reconocer como propia la página `carrie-1976`—.
        // LLAVE 0 — la página es la de OTRA ficha del catálogo, con otro tmdb_id. Prueba
        // definitiva y gratis: no hace falta ni visitarla. Es además la ÚNICA que separa
        // homónimos del mismo año, donde la fecha ya no distingue nada ("El botín" son dos
        // películas de 2026, "Sola" dos de 2020). Si las dos filas resultan ser la misma obra con
        // el tmdb_id mal puesto, quitar la fuente ajena tampoco hace daño: cada ficha se queda
        // con su página, y fundirlas es trabajo de --fuse / --verify, que sí comprueban identidad.
        //
        // Va PRIMERO, antes incluso de la excepción de "es su propia página": una fila puede tener
        // apuntada como principal la página de otra obra —"Moon Knight" apuntaba a la serie "Mo"—
        // y en ese caso lo que está mal es justamente el `source_url` guardado.
        const owner = ownerOf(url);
        if (owner && owner.id !== row.id && owner.tmdb_id > 0 && row.tmdb_id > 0 && owner.tmdb_id !== row.tmdb_id) {
          return {
            url,
            intrusa: true,
            motivo: `es la página propia de "${owner.title}" (${String(owner.release_date || '').slice(0, 4) || '?'}, tmdb ${owner.tmdb_id})`
          };
        }

        // La página de la que SALIÓ la ficha no se juzga por las llaves difusas: si algo no cuadra
        // con ella, el dato dudoso es el `release_date` guardado. Se reconoce por el id de la fila
        // —que ES el slug de su fuente— y, para los ids que no derivan de la url (basura del CMS),
        // por lo que quedó apuntado como fuente principal.
        if (sourceUrlOf(row) === url || esPaginaPropia(row.id, url, type)) {
          return { url, intrusa: false, motivo: 'su propia página' };
        }

        const signals = await RealScraperService.fetchSourceSignals(url).catch(() => null);
        // Página inalcanzable: no es prueba de nada, se conserva.
        if (!signals) return { url, intrusa: false, motivo: 'ilegible' };

        // PRIMERA LLAVE — el año. Es la que destapa los homónimos, que son el caso masivo.
        const pageYear = Number(signals.year) || 0;
        if (fichaYear && pageYear && Math.abs(fichaYear - pageYear) > 1) {
          return { url, intrusa: true, motivo: `"${signals.title}" (${pageYear}) ≠ ficha de ${fichaYear}` };
        }

        // SEGUNDA LLAVE — el nombre, para lo que el año no separa (dos estrenos del mismo año).
        // Aquí hay que ir con mucho cuidado: comparar los títulos MOSTRADOS entre sí no vale de
        // nada, porque los nombres regionales de la misma película no se parecen ("En la tormenta"
        // es "Sin salida"; "Ella" es "Her"; "Volver al Futuro 2" es "Regreso al futuro: Parte II")
        // y retirar una fuente legítima cuesta servidores reales. Así que se pide que NADA la
        // respalde, mirando por este orden:
        //
        //   a) el título ORIGINAL que publica la página ("Back to the Future Part II") — la señal
        //      fuerte, porque es independiente del doblaje de cada país;
        //   b) el título mostrado, por si ya se parece al de la ficha;
        //   c) TMDB, que registra los títulos alternativos y las traducciones de cada ficha.
        const respaldos = [signals.originalTitle, signals.title].filter(Boolean) as string[];
        if (respaldos.some(t => looksLikeSameTitle(t, row))) {
          return { url, intrusa: false, motivo: `"${respaldos.find(t => looksLikeSameTitle(t, row))}" es el nombre de la ficha` };
        }
        if (!(row.tmdb_id > 0)) {
          return { url, intrusa: false, motivo: `"${signals.title}" sin TMDB con quien confirmarlo` };
        }
        for (const t of respaldos) {
          const confirmado = await TmdbService.confirmsTitle(row.tmdb_id, type, t).catch(() => true);
          if (confirmado) return { url, intrusa: false, motivo: `"${t}" lo registra TMDB como nombre suyo` };
        }
        return {
          url,
          intrusa: true,
          motivo: `"${signals.title}"${signals.originalTitle ? ` / "${signals.originalTitle}"` : ''} (${pageYear || '?'}) no es ninguno de los nombres de esta ficha`
        };
      }));

      return { row, veredictos };
    }));

    for (const { row, veredictos } of revisadas) {
      sinAno += veredictos.filter(v => v.motivo === 'ilegible' || v.motivo.includes('sin TMDB')).length;
      const intrusas = veredictos.filter(v => v.intrusa);
      if (intrusas.length === 0) continue;

      const kept = veredictos.filter(v => !v.intrusa).map(v => v.url);
      intrusasTotales += intrusas.length;
      porDuenno += intrusas.filter(v => v.motivo.includes('es la página propia de')).length;
      porAno += intrusas.filter(v => v.motivo.includes('≠ ficha de')).length;
      porNombre += intrusas.filter(v => v.motivo.includes('no es ninguno')).length;

      console.log(`   ␡ ${row.id} "${row.title}" (${String(row.release_date || '').slice(0, 4) || '?'})`);
      for (const v of intrusas) console.log(`       retira ${v.url}\n         ${v.motivo}`);

      // `source_url` (la principal) puede ser justo una de las retiradas.
      const patch: Record<string, unknown> = {
        source_urls: kept,
        source_url: kept.includes(sourceUrlOf(row)) ? sourceUrlOf(row) : (kept[0] || null),
        // Los servidores mezclados no se pueden separar: se vacían para que la próxima
        // resolución los rehaga desde las fuentes legítimas.
        servers: [],
        streams_updated_at: null,
        updated_at: new Date().toISOString()
      };
      if (withAvailability) {
        // El veredicto de disponibilidad se apoyaba en servidores ajenos: vuelve a "sin comprobar".
        patch.has_streams = null;
        patch.streams_checked_at = null;
      }

      if (apply) {
        marcarTocada(row);
        const { error } = await db.from('media_items').update(patch).eq('id', row.id);
        if (error) { console.warn(`     ⚠ ${error.message}`); continue; }
      }
      depuradas++;
    }
  }

  console.log(
    `\n${apply ? '✅ Purga aplicada' : '📋 Dry-run'}: ${depuradas} ficha(s) ${apply ? 'depuradas' : 'a depurar'}, ` +
    `${intrusasTotales} fuente(s) de otra película`
  );
  // El desglose importa: lo que destapa el año es inequívoco (mismo nombre, otra época), mientras
  // que lo que destapa el nombre depende de que la ficha esté bien emparejada con TMDB — si su
  // tmdb_id es el de otra película, lo que sobra es la ficha y no la fuente (ver --verify).
  console.log(`   porque la página es de otra ficha: ${porDuenno} · por el año: ${porAno} · por el nombre: ${porNombre}`);
  if (sinAno > 0) console.log(`   ${sinAno} fuente(s) sin nada con que comprobarlas: se conservan (no hay prueba en contra).`);
  if (depuradas > 0) {
    console.log('   Sus enlaces se rehacen solos en la próxima apertura, o de golpe con `npm run refresh:catalog`.');
  }
  if (!apply && depuradas > 0) console.log('   Ejecuta de nuevo con --apply para escribir los cambios.');
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
          // Respaldo OBLIGATORIO: de aquí sale el póster que se va a escribir, y un match que
          // solo se apoya en el parecido del título traería la carátula de otra película. Sin
          // respaldo se sigue el camino seguro de abajo: conservar el póster de la fuente y
          // vaciar el backdrop.
          if (match.matched && match.verified && match.id > 0) tmdbId = match.id;
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
          marcarTocada(row);
          const { error } = await db.from('media_items').update(patch).eq('id', row.id);
          if (error) { console.warn(`     ⚠ ${error.message}`); failed++; continue; }
        }
        fromTmdb++;
        continue;
      }

      patch.backdrop = null;
      console.log(`   ␡ ${row.id}\n     "${row.title}" sin ficha en TMDB: se conserva el póster y se vacía el backdrop duplicado`);
      if (apply) {
        marcarTocada(row);
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

/**
 * RETIRADA DE SERVIDORES MUERTOS (`--servidores-muertos`).
 *
 * "Que no ofrezca servidores que no funcionan" tenía hasta ahora una sola defensa: comprobarlos al
 * responder. Eso funciona, pero llega tarde y llega poco — la comprobación en vivo tiene 3 s de
 * presupuesto y mira 6 servidores como mucho, así que un vídeo borrado en el séptimo se sigue
 * ofreciendo indefinidamente. Y sobre todo: se vuelve a pagar la comprobación en cada visita.
 *
 * Esto lo mira UNA vez, sin prisa, sobre el catálogo entero, y borra lo que está muerto de verdad.
 * Lo que se retira no es "lo que no supimos extraer" sino lo que el propio host declara ausente:
 *
 *   - la página dice que el fichero se borró o caducó  (vidhideplus, luluvdo)
 *   - responde 404 / 410 / 451                          (streamtape, voe.sx, vudeo.co)
 *   - el dominio acabó aparcado en `wwN.`               (listeamed.net)
 *   - el fichero envuelto ya no existe                  (los pixeldrain de FuegoCine)
 *
 * El juicio lo emite `inspectEmbed`, EL MISMO que decide en producción. Eso es deliberado: si
 * aquí se usara un criterio propio, el catálogo y el reproductor podrían discrepar y nadie se
 * enteraría. Y `inspectEmbed` es conservador donde debe: un 403 de WAF cuenta como VIVO, porque
 * VidHide y StreamWish rechazan a los scrapers y reproducen perfectamente en un navegador.
 *
 *   npm run repair:catalog -- --servidores-muertos                     # solo mide
 *   npm run repair:catalog -- --servidores-muertos --apply             # y los retira
 *   npm run repair:catalog -- --servidores-muertos --apply --limit=500 # por tandas
 */
/**
 * QUÉ MOTIVOS AUTORIZAN A BORRAR. Es más estricto que el que usa el reproductor, a propósito.
 *
 * `inspectEmbed` decide si un servidor se ORDENA detrás; esto decide si DESAPARECE. Lo segundo no
 * tiene vuelta atrás hasta el siguiente crawl, así que solo cuentan los motivos que significan
 * "el host afirma que el fichero no está":
 *
 *   - un 404 / 410 / 451 — el host lo dice con un código, sin ambigüedad;
 *   - la página o el iframe interno muestran el aviso de borrado;
 *   - el dominio acabó aparcado;
 *   - el fichero envuelto ya no existe.
 *
 * Y quedan FUERA, aunque marquen `offline` en producción:
 *
 *   - `excepcion` y `cuerpo-vacio` — un fallo de red nuestro no es una baja suya. Un timeout en
 *     una tanda de 16 peticiones en paralelo diría "muerto" de algo perfectamente vivo.
 *   - `spa-hash-*` — se apoya en que la respuesta de su API mida menos de 3600 bytes, que es una
 *     corazonada, no una afirmación del host. Con ~1.000 servidores de la familia upns detrás, no
 *     es un número que merezca confiarse a un umbral inventado.
 *   - los 5xx — el host está caído HOY, que no es lo mismo que haber borrado el fichero.
 */
function motivoAutorizaBorrar(motivo?: string): boolean {
  if (!motivo) return false;
  if (/^(salto-js-|vudeo-|iframe-interno-)?http-(\d+)$/.test(motivo)) {
    const codigo = Number(motivo.match(/(\d+)$/)?.[1]);
    return codigo === 404 || codigo === 410 || codigo === 451;
  }
  return ['dominio-aparcado', 'salto-js-aparcado', 'vudeo-aparcado',
          'pagina-dice-borrado', 'salto-js-dice-borrado', 'vudeo-dice-borrado',
          'iframe-interno-dice-borrado', 'fichero-envuelto-borrado'].includes(motivo);
}

async function purgeDeadServers(apply: boolean, limitArg?: number, soloHost?: string): Promise<void> {
  console.log(`💀 Buscando servidores muertos${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const rows = (await fetchAllRows(['servers', 'has_streams'])).filter(r => (r.servers || []).length > 0);
  console.log(`   ${rows.length} fichas con servidores guardados`);

  const hostDe = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '(ilegible)';
    }
  };

  // Un embed repetido en veinte fichas se comprueba UNA vez. En un catálogo donde las fuentes
  // reutilizan los mismos enlaces esto no es un detalle: reduce el trabajo a la mitad larga.
  const veredictos = new Map<string, boolean>();
  const pendientes = new Set<string>();
  for (const row of rows) {
    for (const s of row.servers || []) {
      if (!s?.embed_url) continue;
      if (soloHost && !hostDe(s.embed_url).includes(soloHost)) continue;
      pendientes.add(s.embed_url);
    }
  }

  /**
   * VENTANA ROTATORIA, por el mismo motivo que en `--verify`: un `--limit` a secas cogería
   * SIEMPRE los mismos primeros N y el resto del catálogo no se comprobaría nunca. La tanda se
   * deriva del día sobre la lista ordenada, así que la vuelta completa llega sola y se repite —
   * que es justo lo que hace falta con algo que no termina nunca, porque los hosts siguen
   * borrando ficheros.
   */
  const todos = Array.from(pendientes).sort();
  const lote = Number.isFinite(limitArg as number) ? (limitArg as number) : 0;
  let lista = todos;
  if (lote > 0 && lote < todos.length) {
    const vueltas = Math.max(1, Math.ceil(todos.length / lote));
    const desde = (Math.floor(Date.now() / 86400000) % vueltas) * lote;
    lista = todos.slice(desde, desde + lote);
    console.log(`   ventana rotatoria: embeds ${desde}–${desde + lista.length} de ${todos.length} (vuelta completa cada ${vueltas} días)`);
  }
  console.log(`   ${lista.length} embeds distintos por comprobar\n`);

  /**
   * Diez a la vez, no dieciséis. Con dieciséis aparecieron 19 `http-429` en 600 embeds: el límite
   * de peticiones de los propios hosts, provocado por nosotros. No llega a borrar nada de más
   * —un 429 no autoriza a retirar— pero deja sin juzgar a esos servidores, que es peor que ir
   * despacio: la pasada termina y siguen ahí, muertos y ofrecidos.
   */
  const CONCURRENCIA = 10;
  const porMotivo = new Map<string, number>();

  let fichasTocadas = 0;
  let servidoresRetirados = 0;
  let fichasQueSeQuedanSinNada = 0;

  /**
   * Escribe lo decidido HASTA AHORA. Se llama por tandas, no una vez al final.
   *
   * La primera versión comprobaba los 18.732 embeds y solo entonces escribía: dos horas de
   * trabajo que se perdían ENTERAS si el proceso se cortaba, y en un runner de CI con límite de
   * tiempo eso no es una hipótesis. Escribir por tandas es además idempotente — quitar servidores
   * ya quitados no hace nada — así que una corrida interrumpida deja el catálogo mejor que como
   * lo encontró, no igual.
   */
  async function escribirLoDecidido(): Promise<void> {
    for (const row of rows) {
      const antes: any[] = row.servers || [];
      const despues = antes.filter(s => !(s?.embed_url && veredictos.get(s.embed_url) === true));
      if (despues.length === antes.length) continue;

      fichasTocadas++;
      servidoresRetirados += antes.length - despues.length;
      if (despues.length === 0) fichasQueSeQuedanSinNada++;
      row.servers = despues; // para que la siguiente tanda no vuelva a contarlos

      if (!apply) continue;
      marcarTocada(row);
      const { error } = await supabase
        .from('media_items')
        .update({ servers: despues, has_streams: despues.length > 0 })
        .eq('id', row.id);
      if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
    }
  }

  let hechos = 0;
  for (let i = 0; i < lista.length; i += CONCURRENCIA) {
    await Promise.all(
      lista.slice(i, i + CONCURRENCIA).map(async url => {
        try {
          const r = await inspectEmbed(url);
          if (r.status === 'offline') porMotivo.set(r.motivo || '?', (porMotivo.get(r.motivo || '?') || 0) + 1);
          veredictos.set(url, r.status === 'offline' && motivoAutorizaBorrar(r.motivo));
        } catch {
          // No poder mirar no condena: se deja vivo.
          veredictos.set(url, false);
        }
      })
    );
    hechos += Math.min(CONCURRENCIA, lista.length - i);
    if (hechos % 800 < CONCURRENCIA) {
      await escribirLoDecidido();
      console.log(`   ${hechos}/${lista.length} comprobados · ${servidoresRetirados} retirados en ${fichasTocadas} fichas`);
    }
  }
  await escribirLoDecidido();

  const porHost = new Map<string, { muertos: number; total: number }>();
  for (const [url, muerto] of veredictos) {
    const h = hostDe(url);
    const acc = porHost.get(h) || { muertos: 0, total: 0 };
    acc.total++;
    if (muerto) acc.muertos++;
    porHost.set(h, acc);
  }

  console.log('\n🔍 Motivos por los que un embed salió caído (no todos autorizan a borrarlo):');
  for (const [motivo, n] of Array.from(porMotivo).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${motivo.padEnd(30)} ${motivoAutorizaBorrar(motivo) ? '→ se retira' : '→ se DEJA (no es prueba de borrado)'}`);
  }

  console.log(`\n📊 Por host (muertos / comprobados):`);
  for (const [h, a] of Array.from(porHost).sort((x, y) => y[1].muertos - x[1].muertos).slice(0, 15)) {
    if (a.muertos === 0) continue;
    console.log(`   ${h.padEnd(32)} ${String(a.muertos).padStart(5)} / ${String(a.total).padStart(5)}  (${((a.muertos / a.total) * 100).toFixed(0)}%)`);
  }

  console.log(`\n💀 ${servidoresRetirados} servidores muertos en ${fichasTocadas} fichas`);
  if (fichasQueSeQuedanSinNada > 0) {
    console.log(`   ⚠ ${fichasQueSeQuedanSinNada} fichas se quedan SIN ningún servidor (no tenían más que muertos)`);
  }
  console.log(apply ? '   ✅ retirados' : '   (dry-run: repite con --apply para retirarlos)');

  await purgarCacheDeTocadas(apply);
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
      process.argv.includes('--restart'),
      process.argv.includes('--rotar'),
      process.argv.includes('--tipos'),
      (process.argv.find(a => a.startsWith('--ids=')) || '').split('=')[1]?.split(',').map(s => s.trim()).filter(Boolean)
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

  if (process.argv.includes('--purgar-cache')) {
    if (process.argv.includes('--fantasmas')) {
      await purgeGhostCacheEntries(apply);
      return;
    }
    const h = parseInt((process.argv.find(a => a.startsWith('--desde=')) || '').split('=')[1] || '', 10);
    const idsArg = (process.argv.find(a => a.startsWith('--ids=')) || '').split('=')[1];
    await purgeRecentlyChanged(
      apply,
      Number.isFinite(h) && h > 0 ? h : 24,
      idsArg ? idsArg.split(',').map(x => x.trim()).filter(Boolean) : undefined
    );
    return;
  }

  if (process.argv.includes('--fuentes')) {
    await purgeIntruderSources(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--servidores-muertos')) {
    await purgeDeadServers(
      apply,
      Number.isFinite(limitArg) ? limitArg : undefined,
      (process.argv.find(a => a.startsWith('--host=')) || '').split('=')[1]
    );
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
  let dudosas = 0;
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
              marcarTocada(twin);
              const { error: mergeErr } = await db.from('media_items').update(patch).eq('id', twin.id);
              if (mergeErr) {
                console.warn(`     ⚠ no se pudo enriquecer la gemela ${twin.id}: ${mergeErr.message} (no se borra el duplicado)`);
                collisions++;
                continue;
              }
            }
            marcarTocada(row);
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

      // Y no se sustituye una ficha sin RESPALDO independiente del título: de aquí sale el
      // póster, la sinopsis y el reparto que se van a escribir. El parecido del nombre —incluso
      // clavado— no distingue homónimos ("Solo en casa" calca a "Gambling House", 1950), y el
      // respaldo de público tampoco: la más votada de las dos puede ser la que no es. Hace falta
      // el año, el título original o el `og:image` de la página; `--refetch` los va a buscar.
      if (!match.verified) {
        dudosas++;
        console.log(
          `   ~ ${row.id}\n     "${row.title}" podría ser "${newDetails?.title || newDetails?.name || match.id}" (score ${match.score.toFixed(2)})` +
          ` pero nada independiente del título lo respalda: se deja igual${refetch ? '' : ' (prueba con --refetch)'}`
        );
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

      marcarTocada(row);
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
    `${dudosas} sin respaldo independiente (se dejan igual), ` +
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

// La purga del caché va DESPUÉS de main y fuera de ella: main tiene una salida por modo (once
// `return`), y colgar la purga de cada una es la forma segura de olvidarse de alguna.
main()
  .then(() => purgarCacheDeTocadas(process.argv.includes('--apply')))
  .then(() => exitWhenSettled(0))
  .catch(err => {
    console.error('❌ repairCatalog:', err);
    exitWhenSettled(1);
  });
