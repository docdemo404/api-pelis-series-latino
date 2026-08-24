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
 *   npm run repair:catalog -- --purgar-sin-identidad
 *                                                 # fichas de archive.org que TMDB no reconoce
 *   npm run repair:catalog -- --purgar-sin-identidad --apply
 *                                                 # …y las borra (pásalo SIEMPRE después de --fuse)
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
import axios from 'axios';
import { TmdbService, tmdbImagePath, OTRO_ALFABETO, similarity as tmdbSimilarity } from '../src/services/tmdbService';
import { RealScraperService, SourceSignals, identidadDeArchive, nombreDeLaDescripcion } from '../src/services/realScraperService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, normalizeTitle, searchIndexKey, dedupeTitles, sourceTitleFromSlug, slugify } from '../src/utils/text';
// La puerta de identidad de las fuentes vive en catalogService: el script y la API tienen que
// decidir lo MISMO sobre qué página pertenece a qué ficha.
import { CatalogService, esPaginaPropia, candidateIdsForUrl, tipoDeLaRuta, duenoDeLaPagina, fusionarTemporadas } from '../src/services/catalogService';
import { CacheStore } from '../src/cache/store';
import { streamClient } from '../src/utils/httpClient';
import { inspectEmbed } from '../src/scrapers/embedHealth';
import { bestMode, policyFor } from '../src/scrapers/hostPolicy';
import { sinVideoDirecto, comprobarEmbed } from '../src/services/playbackHealth';
import { hasVolatileToken } from '../src/scrapers/directStream';
import { directEndpointUrl } from '../src/scrapers/directStream';
import { nombreConTipo, paraElCliente, fichaReproducible, veredictoDisponibilidad } from '../src/services/streamSorter';
import { extraerManuales, fusionarConLedger, leerLedger, ledgerVacio, todoElLedger, esManual } from '../src/services/manualLedger';
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
  const columns = ['id', 'tmdb_id', 'type', 'title', 'original_title', 'aliases', 'release_date', 'source_url', 'poster']
    .concat(extraColumns)
    .join(',');

  /**
   * MIL FILAS SON MUCHAS CUANDO CADA UNA TRAE `servers` Y `seasons` DENTRO.
   *
   * Son las dos columnas más pesadas de la tabla —decenas de servidores y todos los capítulos de
   * cada serie—, y ya está medido en catalogService: 800 filas así pesan 23,7 MB. Pedirlas de mil
   * en mil es lo que reventó `--verificar`, que llevaba días muriendo con «canceling statement due
   * to statement timeout» sin comprobar UN SOLO servidor. Doscientas cuando vienen esas columnas.
   */
  const pesada = extraColumns.some(c => c === 'servers' || c === 'seasons');
  const PAGE = pesada ? 200 : 1000;

  /**
   * Y SE PAGINA POR CLAVE, NO POR DESPLAZAMIENTO.
   *
   * `range(from, …)` obliga a Postgres a recorrer y descartar las `from` filas anteriores en cada
   * página, así que cada una cuesta más que la última: con 14.723 fichas, las últimas se pasaban
   * del tope de tiempo aunque las primeras fueran de sobra. Pedir «las N siguientes a este id»
   * cuesta lo mismo en la página 1 que en la 70, porque entra por el índice de la clave primaria.
   *
   * El orden por `id` no es un capricho: es lo que hace que «la siguiente» esté definida. Ninguna
   * de las reparaciones depende del orden en que lleguen las filas.
   */
  let ultimo = '';
  for (;;) {
    let q = db.from('media_items').select(columns).order('id', { ascending: true }).limit(PAGE);
    if (ultimo) q = q.gt('id', ultimo);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    ultimo = (data[data.length - 1] as any).id;
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
/**
 * CON QUÉ NOMBRE SE LE PREGUNTA A TMDB POR UNA FICHA QUE SE QUEDÓ SIN IDENTIDAD.
 *
 * Con el título guardado a secas se recuperaban CERO de las doce fichas de archive.org que
 * estaban así, y no por ambigüedad: el título de archive.org lo escribe quien sube el fichero y
 * llega con la coletilla del doblaje pegada y a menudo cortada —«Hallam Foe Inglés + Subtítulos
 * En»—. El identificador del archivo (`hallam-foe-2007`) es el mismo nombre sin el ruido, y con
 * él se recuperan ocho, todas respaldadas.
 *
 * Se prueban en orden y se para en el primero que venga RESPALDADO: la escalera no relaja nada,
 * solo le da al matcher el nombre en las formas en que la fuente pudo escribirlo.
 */
async function nombresParaReintentar(row: any): Promise<Array<{ titulo: string; year: string; via: string }>> {
  const yearGuardado = String(row.release_date || '').slice(0, 4) || sourceTitleFromId(row.id).year || '';
  const escalera: Array<{ titulo: string; year: string; via: string }> = [];

  const identificador = String(row.id || '').replace(/^archive-/, '');
  if (String(row.id || '').startsWith('archive-')) {
    const { titulo, year } = identidadDeArchive(identificador);
    if (titulo) {
      escalera.push({ titulo, year: year || yearGuardado, via: 'identificador' });
      // Sin año también: el que trae la descripción puede ser el equivocado y tapar el acierto
      // («La Gorra 2» estaba guardada con 2019 y su archivo dice 2009).
      if (year && yearGuardado && year !== yearGuardado) escalera.push({ titulo, year, via: 'identificador (su año)' });
    }
  }

  const guardado = String(row.title || '').trim();
  if (guardado) escalera.push({ titulo: guardado, year: yearGuardado, via: 'título guardado' });

  /**
   * ÚLTIMO PELDAÑO, Y EL ÚNICO QUE CUESTA UNA PETICIÓN: el nombre que quien subió el fichero
   * escribió en la DESCRIPCIÓN. Va el último a propósito —se paga solo cuando los tres gratis han
   * fallado— y es el que rescata a `0059-40-pistolas`, que no se encuentra ni por su identificador
   * («40 pistolas») ni por su título mostrado, y sí por el «Cuarenta pistolas (1957)» con que abre
   * su descripción: TMDB la registra como «Dragones de la violencia» y ese es el nombre alternativo
   * que conoce.
   */
  if (identificador && String(row.id || '').startsWith('archive-')) {
    const desc = await descripcionDeArchive(identificador);
    const deLaDescripcion = nombreDeLaDescripcion(desc);
    if (deLaDescripcion && !escalera.some(e => canonicalTitle(e.titulo) === canonicalTitle(deLaDescripcion))) {
      escalera.push({ titulo: deLaDescripcion, year: yearGuardado, via: 'descripción de archive.org' });
    }
  }

  return escalera;
}

/** La descripción de un item de archive.org. Vacía si no contesta: nunca hace fallar la pasada. */
async function descripcionDeArchive(identifier: string): Promise<string> {
  try {
    const res = await axios.get(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { timeout: 12000 });
    return String(res.data?.metadata?.description || '');
  } catch {
    return '';
  }
}

async function fuseSyntheticDuplicates(apply: boolean, limitArg?: number): Promise<void> {
  const DELETE_SCORE = 0.9;

  console.log(`🔗 Buscando duplicados entre fuentes${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const withMultiSource = await hasColumn('source_urls');
  if (!withMultiSource) {
    console.warn('   ⚠ Columna source_urls ausente — ejecuta src/db/migrations/005_multisource_and_availability.sql.');
    console.warn('     Sin ella la fusión perdería la fuente de la ficha absorbida: se aborta.');
    return;
  }

  // Hace falta para reescribir la ficha entera al adoptar un tmdb_id (ver más abajo).
  const withMetadataSource = await hasColumn('metadata_source');

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
      for (const intento of await nombresParaReintentar(row)) {
        const m = await TmdbService
          .resolveTmdb(intento.titulo, type, intento.year || undefined, row.id)
          .catch(() => null);
        if (m && m.matched && m.verified && m.id > 0) return { row, type, match: m, via: intento };
      }
      return { row, type, match: null, via: null };
    }));

    for (const { row, type, match, via } of results) {
      if (!match || !match.matched || match.id <= 0) {
        stillUnmatched++;
        continue;
      }

      const { data: clash } = await db
        .from('media_items')
        .select('id,title,original_title,aliases,release_date,source_url,source_urls')
        .eq('tmdb_id', match.id)
        .neq('id', row.id)
      /**
       * a) EL TMDB_ID ESTÁ LIBRE: la ficha lo adopta Y SE REESCRIBE ENTERA.
       *
       * Aquí solo se escribía el número. La fila se quedaba con el título del que subió el
       * fichero —«Hallam Foe Inglés + Subtítulos En»—, sin carátula y sin sinopsis, o sea
       * anunciándose por fin y en el peor estado posible. `rewriteRowFromMatch` es la que trae
       * la ficha de TMDB y la escribe completa; ya la usan `--verify` y `--refetch`.
       */
      if (!clash || clash.length === 0) {
        const nombre = await rewriteRowFromMatch(
          row,
          type,
          match.id,
          { title: via!.titulo, year: via!.year, originalTitle: null, imageHint: null } as any,
          { apply, withMetadataSource }
        );
        console.log(
          `   ↑ ${row.id}` +
          `
     "${row.title}" adopta tmdb ${match.id} (score ${match.score.toFixed(2)}, por ${via!.via})` +
          `
       queda como "${nombre.title || row.title}"`
        );
        if (apply && !nombre.title) { skipped++; continue; }
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
      /**
       * Se confirma con EL NOMBRE QUE DIO EL MATCH, no con el guardado. En archive.org el guardado
       * es el que escribió quien subió el fichero —«The Dreamers Inglés + Subtítulos En»— y TMDB
       * no registra ese nombre para nadie, así que la reja rechazaba una fusión correcta: tmdb 1278
       * se llama «The Dreamers» en original y así es como se le encontró.
       */
      const confirmed = await TmdbService.confirmsTitle(match.id, type, via!.titulo).catch(() => false);
      if (!confirmed) {
        skipped++;
        console.log(`   ! ${row.id}\n     "${row.title}" → tmdb ${match.id} = "${twin.title}", pero TMDB no registra ese nombre para la ficha: no se funde`);
        continue;
      }

      // Tercera llave: la época. Un remake registra en TMDB los mismos nombres que el original
      // —los confirma la llave anterior sin pestañear— y aun así es otra película con otros
      // servidores. Con el año en la mano no hay que suponer nada.
      const twinYear = Number(String(twin.release_date || '').slice(0, 4)) || Number(sourceTitleFromId(twin.id).year) || 0;
      // El año de la fila se vuelve a calcular aquí: el `year` de arriba vive dentro del `map`
      // que resolvió el lote y no llega a este bucle. Escribirlo tal cual compilaba en local
      // —`tsconfig.json` no incluía este fichero— y reventaba en CI, que sí lo compila.
      const rowYear = Number(String(row.release_date || '').slice(0, 4) || sourceTitleFromId(row.id).year) || 0;
      if (rowYear && twinYear && Math.abs(rowYear - twinYear) > 1) {
        skipped++;
        console.log(`   ! ${row.id}\n     "${row.title}" (${rowYear}) ~ ${twin.id} = "${twin.title}" (${twinYear}): mismo nombre, otra época — no se funde`);
        continue;
      }

      /**
       * b) DUPLICADO CONFIRMADO. Lo funde `fuseRowInto`, no una copia de su código.
       *
       * Aquí se volcaban a mano solo la página de origen y los alias, y acto seguido la fila se
       * BORRABA. O sea que un duplicado con capítulos resueltos se llevaba sus enlaces a la
       * basura: «La casa del dragón» de FuegoCine tenía 14 enlaces de capítulo, y esta pasada
       * los habría borrado sin decir nada. `fuseRowInto` —la que usan `--verify` y `--dedupe`—
       * ya vuelca ADEMÁS los capítulos (con `fusionarTemporadas`, que no reemplaza nunca), los
       * servidores de ficha y `has_streams`, y trae de propina la reja del año.
       *
       * Es la clase de fallo que se evita llamando en vez de copiando: el volcado completo se
       * escribió una vez, y este modo se había quedado con la versión de antes.
       */
      const resultado = await fuseRowInto(row, twin, [...(row.aliases || []), row.title], {
        apply,
        withMultiSource,
        sourceYear: String(rowYear || ''),
      });

      console.log(
        `   ⇄ ${row.id}` +
        `\n     "${row.title}" se funde en ${twin.id} = "${twin.title}" (tmdb ${match.id})` +
        `\n       fuentes: ${resultado.urls[0]} → ${resultado.urls[1]}` +
        ` · alias: ${resultado.aliases[0]} → ${resultado.aliases[1]}` +
        `\n       capítulos con vídeo: ${resultado.capitulos[0]} → ${resultado.capitulos[1]}` +
        (resultado.rechazada ? `\n       RECHAZADA: ${resultado.rechazada}` : '')
      );

      if (!resultado.ok) {
        skipped++;
        continue;
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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * BORRA LAS FICHAS DE ARCHIVE.ORG QUE SIGUEN SIN IDENTIDAD EN TMDB (`--purgar-sin-identidad`).
 *
 * Es la regla que el crawl ya aplica al ENTRAR y que nadie aplicaba a lo que entró antes de que
 * existiera (ver el bloque de `fallbacks` en `refreshCatalog`): en archive.org no hay título de
 * catálogo, hay el nombre que le puso quien subió el fichero, así que hace falta un árbitro
 * externo. Ese árbitro es TMDB, y si TMDB no reconoce la obra, la obra no entra.
 *
 * Solo archive.org. Las demás fuentes publican títulos de verdad y su ficha sin identidad se
 * queda donde está.
 *
 * Se ejecuta DESPUÉS de `--fuse`, nunca antes: primero se agota el intento de identificarlas —que
 * con la escalera de nombres recupera la mayoría— y solo se borra lo que queda. De las 12 que
 * había el 2026-08-24, `--fuse` rescató 9 y aquí cayeron 3: la cartelera semanal de un canal, un
 * documental de Animal Planet y una película real cuyo título en español TMDB no registra.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function purgarSinIdentidad(apply: boolean): Promise<void> {
  console.log(`🗑  Buscando fichas de archive.org sin identidad en TMDB${apply ? '' : ' (dry-run: no se borra nada)'}...`);

  const rows = (await fetchSyntheticRows()).filter(r => String(r.id || '').startsWith('archive-'));
  if (!rows.length) {
    console.log('   ninguna: todas las fichas de archive.org tienen su ficha de TMDB.');
    return;
  }

  console.log(`   ${rows.length} ficha(s) que TMDB no reconoce
`);
  let borradas = 0;
  for (const row of rows) {
    console.log(`   ${apply ? '✖' : '·'} ${row.id}
     "${row.title}" (${String(row.release_date || '').slice(0, 4) || 'sin año'})`);
    if (!apply) continue;
    marcarTocada(row);
    const { error } = await db.from('media_items').delete().eq('id', row.id);
    if (error) { console.warn(`     ⚠ no se pudo borrar: ${error.message}`); continue; }
    borradas++;
  }

  console.log(`
${apply ? `✅ ${borradas} ficha(s) borradas` : `📋 Dry-run: ${rows.length} se borrarían`}`);
  if (!apply) console.log('   Ejecuta de nuevo con --apply para borrarlas.');
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
  opts: { apply: boolean; withMultiSource: boolean; sourceYear?: string; pruebaDeImagen?: boolean }
): Promise<{
  ok: boolean;
  urls: [number, number];
  aliases: [number, number];
  /** Capítulos con vídeo de la ficha que se queda, antes y después de absorber al duplicado. */
  capitulos: [number, number];
  rechazada?: string;
}> {
  // El año de la fila se toma de su PÁGINA de origen, no de `release_date`.
  //
  // Aquí se llega porque la página confirmó que la fila es la ficha que ya tiene la gemela, así
  // que lo guardado es justo el dato en duda: en una fila mal emparejada `release_date` es el de
  // la película equivocada. Comparando eso, la reja rechazaba dedupes legítimos —el pack
  // "One Piece Todas Las Temporadas" estaba guardado como "ONE PIECE BONUS CONTENT" (2026) y no
  // se dejaba fundir con "ONE PIECE" (2023), que es lo que es—.
  /**
   * Y si la página tampoco publica año, manda el del EMPAREJAMIENTO que acaba de confirmarse,
   * no el guardado.
   *
   * Sin esto la reja se volvía circular y bloqueaba justo las correcciones que más falta hacen.
   * `fc-merlina` estaba emparejada con "Merlina" (1983), una serie homónima de 4 votos; su página
   * es la de un episodio (`merlina-2x8`) y no lleva año, así que `sourceYear` venía vacío y se
   * caía al `release_date` guardado — que ES el error— para decidir: «"Merlina" (1983) y
   * "Merlina" (2022) no son de la misma época». O sea, el año de la ficha equivocada impidiendo
   * arreglar esa ficha equivocada.
   *
   * Aquí solo se llega cuando el re-emparejamiento vino RESPALDADO (en este caso por el hash del
   * fotograma del episodio, que no admite parecidos). Contra esa prueba, un año guardado que
   * procede del emparejamiento en duda no puede tener voto.
   */
  const yearA = Number(opts.sourceYear)
    || Number(String(row.release_date || '').slice(0, 4))
    || Number(sourceTitleFromId(row.id).year) || 0;
  const yearB = Number(String(twin.release_date || '').slice(0, 4)) || Number(sourceTitleFromId(twin.id).year) || 0;

  // Sin año en la página y con la identidad probada por el HASH de una imagen, el año guardado
  // no tiene voto: procede del emparejamiento que estamos corrigiendo.
  const sinAnoPropio = !Number(opts.sourceYear);
  const mandaLaImagen = sinAnoPropio && opts.pruebaDeImagen === true;

  if (!mandaLaImagen && yearA && yearB && Math.abs(yearA - yearB) > 1) {
    return {
      ok: false,
      urls: [0, 0],
      aliases: [0, 0],
      capitulos: [0, 0],
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

  /**
   * LO QUE EL DUPLICADO TENÍA DE VERDAD: SUS CAPÍTULOS Y SUS ENLACES. Se vuelcan ANTES de borrarlo.
   *
   * Esta función absorbía la página de origen y el nombre, y acto seguido borraba la fila. Todo lo
   * que esa fila había costado —los capítulos que el crawl resolvió uno a uno, con su vídeo ya
   * comprobado— se iba con ella. Con `fc-merlina` son 16 capítulos de FuegoCine reproduciéndose;
   * la ficha que se queda (moviedays) los tiene por otro camino, pero un capítulo con dos fuentes
   * se ve el doble de veces que uno con una, y el día que una fuente caiga se nota.
   *
   * Se fusiona con `fusionarTemporadas`, la misma que usan el crawl y la API: la ficha que se
   * queda conserva TODO lo suyo, los capítulos que solo tenía el duplicado se añaden y los
   * comunes acumulan los servidores de los dos. Reemplazar aquí sería borrar capítulos, que es el
   * fallo que este proyecto ya ha cometido tres veces.
   *
   * Los cuerpos se releen por id: las consultas que traen `row` y `twin` no piden estas columnas
   * —son las más pesadas de la tabla— y pedirlas para todo el catálogo por un caso que aparece
   * una vez cada mil filas sería pagar el peaje al revés.
   */
  const { data: cuerpos } = await db
    .from('media_items').select('id,seasons,servers,has_streams').in('id', [row.id, twin.id]);
  const cuerpoDe = (id: string): any => ((cuerpos as any[]) || []).find(f => String(f.id) === String(id)) || {};
  const delDuplicado = cuerpoDe(row.id);
  const deLaQueSeQueda = cuerpoDe(twin.id);

  const conVideo = (temps: any[]) => (temps || []).reduce(
    (n: number, t: any) => n + (t?.episodes || []).filter((e: any) => (e?.servers || []).length > 0).length, 0);

  const temporadasPrevias: any[] = Array.isArray(deLaQueSeQueda.seasons) ? deLaQueSeQueda.seasons : [];
  const temporadasDelDup: any[] = Array.isArray(delDuplicado.seasons) ? delDuplicado.seasons : [];
  const temporadasFusionadas = temporadasDelDup.length
    ? fusionarTemporadas(temporadasPrevias, temporadasDelDup)
    : temporadasPrevias;

  const urlDeServidor = (sv: any) => String(sv?.direct_stream || sv?.embed_url || '');
  const enlacesPrevios: any[] = Array.isArray(deLaQueSeQueda.servers) ? deLaQueSeQueda.servers : [];
  const yaEstan = new Set(enlacesPrevios.map(urlDeServidor));
  const enlacesNuevos = (Array.isArray(delDuplicado.servers) ? delDuplicado.servers : [])
    .filter((sv: any) => urlDeServidor(sv) && !yaEstan.has(urlDeServidor(sv)));

  const sizes = {
    urls: [currentUrls.length, mergedUrls.length] as [number, number],
    aliases: [currentAliases.length, mergedAliases.length] as [number, number],
    capitulos: [conVideo(temporadasPrevias), conVideo(temporadasFusionadas)] as [number, number]
  };
  if (!opts.apply) return { ok: true, ...sizes };

  const patch: Record<string, unknown> = {};
  if (opts.withMultiSource && mergedUrls.length > currentUrls.length) patch.source_urls = mergedUrls;
  if (mergedAliases.length > currentAliases.length) {
    patch.aliases = mergedAliases;
    patch.title_normalized = searchIndexKey(twin.title, twin.original_title, mergedAliases);
  }
  // Solo se escribe el árbol si SUMA: un update que deja la columna igual reescribe un JSON
  // enorme y mueve `updated_at`, que es por donde ordenan los feeds.
  const bulto = (temps: any[]) => (temps || []).reduce(
    (n: number, t: any) => n + (t?.episodes || []).reduce(
      (m: number, e: any) => m + 1 + (e?.servers || []).length, 0), 0);
  if (bulto(temporadasFusionadas) > bulto(temporadasPrevias)) patch.seasons = temporadasFusionadas;
  if (enlacesNuevos.length) patch.servers = [...enlacesPrevios, ...enlacesNuevos];
  // Y si lo absorbido reproduce, la que se queda deja de estar escondida (`has_streams` gobierna
  // portada y buscador). El duplicado solo llega con `true` habiendo demostrado vídeo.
  if (delDuplicado.has_streams === true && deLaQueSeQueda.has_streams !== true
    && (patch.seasons || patch.servers)) {
    patch.has_streams = true;
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
    imageHint: signals.imageHint || null,
    episodeHint: signals.episode || null
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
      `\n       se funde ahí (fuentes ${merged.urls[0]}→${merged.urls[1]}, alias ${merged.aliases[0]}→${merged.aliases[1]},` +
      ` capítulos con vídeo ${merged.capitulos[0]}→${merged.capitulos[1]}) y libera el ${twin.tmdb_id}`
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

/**
 * Retira del caché todo lo que se haya tocado. Se llama una vez, al final.
 *
 * Y DESDE AHORA TAMBIÉN LOS LISTADOS, que era el último sitio por donde se colaba lo retirado.
 *
 * Esto purgaba la ficha (`meta:`, `byid:`) y sus capítulos (`ep:`), pero no la portada ni las
 * búsquedas — y ahí es donde el espectador ve el catálogo. La portada se guarda hasta 12 h y las
 * búsquedas una hora, así que una película que el barrido acababa de retirar de la base de datos
 * seguía apareciendo en el inicio media jornada, con su ficha ya diciendo que no hay nada.
 *
 * Medido al final de todo el trabajo, cuando ya no quedaba ninguna otra causa: de los cinco
 * títulos que aún salían sin fuente, «Caminando Con Dinosaurios» y «La La Land» tenían
 * `has_streams = false` desde hacía minutos. No era un fallo de criterio: era una foto vieja.
 *
 * Se purga TODO el listado, no las entradas que contengan la ficha: no hay forma de saber en qué
 * consultas sale, y reconstruirlos cuesta una lectura a la base. Ver `invalidateListings`.
 */
async function purgarCacheDeTocadas(apply: boolean): Promise<void> {
  if (!apply || tocadas.length === 0) return;
  await CatalogService.invalidateListings().catch(() => {});
  const vistas = new Set<string>();
  const unicas = tocadas.filter(t => (vistas.has(t.id) ? false : (vistas.add(t.id), true)));
  const claves = unicas.flatMap(t => CatalogService.cacheKeysFor(t));

  // Los EPISODIOS se cachean aparte, bajo `ep:<id>:<temporada>:<episodio>`, y no se pueden
  // enumerar sin saber cuántos hay. Se resuelven de una sola pasada: se piden todas las claves
  // `ep:*` y se cruzan con las fichas tocadas — mucho más barato que un patrón por ficha cuando
  // se han tocado miles. Sin esto, una reparación de servidores queda arreglada en la ficha y
  // sigue saliendo mal en el capítulo, que es justo donde el espectador la ve.
  const idsTocados = new Set(unicas.map(t => t.id));
  const deEpisodios = (await CacheStore.keys('ep:*')).filter(k => idsTocados.has(k.split(':')[1]));
  claves.push(...deEpisodios);

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
        imageHint: signals.imageHint || null,
        episodeHint: signals.episode || null
      }).catch(() => null);

      /**
       * Etapa 3, SOLO PARA SERIES SIN RESPALDO: preguntarle a otro de sus capítulos.
       *
       * Una serie cuya página de origen es la de un capítulo se identifica por el fotograma, y no
       * todas sus páginas sirven: medido sobre «Stranger Things», 35 de sus 42 capítulos traen un
       * fotograma registrado en TMDB y 7 no — entre ellos justo el que quedó de página de origen.
       * Rendirse con la primera es jugarse la ficha a un 17 % de fallo por serie.
       *
       * Cuesta una lectura de la fila (los capítulos con su url no vienen en el listado, que ya es
       * pesado de sobra) y como mucho tres páginas, y solo para las series que no se han podido
       * respaldar. Lo que se exige para adoptar la ficha no cambia: `identidadPorFotograma`
       * devuelve únicamente lo confirmado por el hash de una imagen.
       */
      if (type === 'tvseries' && !match?.verified) {
        const { data: fila } = await db.from('media_items').select('seasons').eq('id', row.id).maybeSingle();
        const paginas = RealScraperService.paginasDeCapitulos((fila as any)?.seasons, sourceUrlOf(row));
        const identidad = paginas.length
          ? await RealScraperService.identidadPorFotograma(paginas).catch(() => null)
          : null;
        if (identidad) return { row, type, signals: identidad.signals, confirmedByImage: false, match: identidad.match };
      }

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
        .from('media_items').select(clashColumns).eq('tmdb_id', match.id).neq('id', row.id);

      /**
       * De todas las que tienen ese número, la que importa es la del MISMO catálogo.
       *
       * Antes se pedía `.limit(1)` sin ordenar, y eso dejó a "El Continental: Del mundo de John
       * Wick" sin arreglo posible. Tres fichas comparten el número 72710: la película "La
       * Huésped" (legítima), la serie buena de El Continental, y este duplicado. La consulta
       * devolvía la PELÍCULA, así que el código se iba por la rama de "mismo número, otro
       * catálogo", intentaba escribir, la tabla lo rechazaba —porque el choque de verdad estaba
       * en su propio catálogo, no ahí— y acababa dándose por bloqueado señalando una migración
       * que llevaba tiempo aplicada. El duplicado real nunca llegó a mirarse.
       *
       * Con el UNIQUE en (tmdb_id, type), la única fila que puede estorbar es la de su tipo.
       */
      const mismoTipo = (f: any) => (f.type === 'tvseries' ? 'tvseries' : 'movie') === match.type;
      let twin: any = (clash || []).find(mismoTipo) || (clash || [])[0] || null;

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
        const merged = await fuseRowInto(row, twin, [signals.title], {
          apply, withMultiSource, sourceYear: signals.year,
          // La página no publica año pero sí una imagen de TMDB que casó por hash: esa prueba
          // manda sobre el `release_date` guardado, que es justo el dato en duda.
          pruebaDeImagen: Boolean(signals.imageHint) && match.verified,
        });
        if (merged.rechazada) {
          blocked++;
          console.log(`   ! ${row.id}\n     comparte tmdb ${match.id} con ${twin.id} pero NO se funde: ${merged.rechazada}`);
          continue;
        }
        if (!merged.ok) continue;
        console.log(
          `   ⇄ ${row.id}\n     "${row.title}" (tmdb ${row.tmdb_id}) era en realidad "${signals.title}" = tmdb ${match.id}, que ya es ${twin.id} = "${twin.title}"` +
          `\n       se funde ahí (fuentes ${merged.urls[0]}→${merged.urls[1]}, alias ${merged.aliases[0]}→${merged.aliases[1]},` +
          ` capítulos con vídeo ${merged.capitulos[0]}→${merged.capitulos[1]}) y se elimina el duplicado`
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
  const ownerOf = (url: string): any => duenoDeLaPagina(url, byId);

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
        /**
         * Y si la intrusa era su ÚNICA página, la ficha se queda huérfana: sin servidores y sin
         * nadie a quien pedírselos. Eso no es "sin comprobar", es que no hay nada que comprobar,
         * y dejarla en `null` la mantenía visible en el home y en la búsqueda para siempre — una
         * ficha que al abrirla no ofrece nada. Es lo que pasó con "Ronaldinho": se le retiró la
         * página de otra película, que era la suya, y se quedó ahí.
         *
         * Se marca fantasma, no se borra: el crawl puede volver a encontrarle su página y
         * entonces esto se recalcula solo. Borrarla tiraría su metadata para nada.
         */
        const sinFuente = kept.length === 0;
        patch.has_streams = sinFuente ? false : null;
        patch.streams_checked_at = sinFuente ? new Date().toISOString() : null;
        if (sinFuente) console.log(`       ↳ se queda sin ninguna página: se retira de los listados`);
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
  const rows = (await fetchAllRows(['servers', 'seasons', 'has_streams'])).filter(r => (r.servers || []).length > 0);
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
  /**
   * SE ALTERNAN LOS HOSTS. Esto no es un detalle de estilo: es lo que decide si la pasada mide
   * algo o no mide nada.
   *
   * Ordenados por url, los embeds quedan agrupados por host, así que las diez peticiones en vuelo
   * caen todas sobre el mismo sitio. Medido en vudeo.co: de 1.018 comprobaciones, **995 volvieron
   * 429**. Un 429 no borra nada —eso está bien— pero deja el servidor sin juzgar, y la pasada
   * termina dando 17 bajas de un host que está muerto al 100%. Peor aún: parece un resultado.
   *
   * Repartiendo por turnos entre hosts, con diez en vuelo y decenas de hosts, a cada uno le llega
   * como mucho una petición a la vez.
   */
  const porHostCola = new Map<string, string[]>();
  for (const url of Array.from(pendientes).sort()) {
    const h = hostDe(url);
    (porHostCola.get(h) || porHostCola.set(h, []).get(h)!).push(url);
  }
  const todos: string[] = [];
  for (let fila = 0; todos.length < pendientes.size; fila++) {
    for (const cola of porHostCola.values()) if (fila < cola.length) todos.push(cola[fila]);
  }
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
   * La concurrencia se deriva de CUÁNTOS HOSTS hay, no de un número elegido a ojo.
   *
   * Lo que provoca los 429 no es el total de peticiones en vuelo sino cuántas caen sobre el mismo
   * sitio: con la lista agrupada por host, diez en paralelo bastaban para que vudeo rechazara 995
   * de 1.018 comprobaciones. Con los hosts alternados y dos peticiones por host, cada uno recibe
   * como mucho un par a la vez — y una pasada acotada a un solo host (`--host=`) baja sola a dos
   * en vez de arrasarlo con veinticuatro.
   */
  const CONCURRENCIA = Math.max(2, Math.min(24, porHostCola.size * 2));
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
      const { error } = await db
        .from('media_items')
        // `despues.length > 0` decidía sobre una SERIE mirando solo lo que cuelga de la película,
        // y con un criterio que ya no era el de salida. Ver `fichaReproducible`.
        .update({ servers: despues, has_streams: veredictoDisponibilidad({ type: row.type, servers: despues, seasons: row.seasons }, 'todo') ?? row.has_streams })
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

/**
 * SINOPSIS DE RELLENO (`--sinopsis`).
 *
 * Una ficha puede haber adoptado su película de TMDB —con su póster, su título y su tmdb_id— y
 * quedarse con la frase de relleno de la fuente: "Ver Max ha desaparecido online gratis en HD con
 * audio Latino", que no cuenta absolutamente nada de la película. Son 174 fichas, el 1,2% de las
 * emparejadas.
 *
 * Pasaba porque TMDB tiene la sinopsis en inglés pero VACÍA en español, y el código solo probaba
 * es-MX y es-ES antes de rendirse. Ya se busca también entre sus traducciones (ver
 * `getTmdbDetails`), así que aquí basta con volver a pedirlas.
 *
 *   npm run repair:catalog -- --sinopsis            # mide
 *   npm run repair:catalog -- --sinopsis --apply    # y las rellena
 */
const SINOPSIS_DE_RELLENO = /^Ver .* online (gratis )?(en |con )/i;

async function repairFillerOverviews(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`📝 Buscando huecos de metadata${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const rows = await fetchAllRows(['overview', 'metadata_source', 'poster']);

  /**
   * Se rellenan los TRES huecos, no solo la sinopsis.
   *
   * La primera versión solo miraba el texto, y el PASO 5 recién estrenado encontró siete series
   * a las que lo que les faltaba era la FECHA DE ESTRENO —"WandaVision", "Alien: Earth",
   * "Marvel Zombies"…—, todas agrupadas de FuegoCine. Son el mismo caso de "Invencible": su
   * página de origen es la de un episodio y no publica el año, así que la ficha se quedó sin él
   * aunque TMDB lo tenga. Y una ficha sin año no se puede ni auditar contra su fuente: el año es
   * la señal con la que se descartan los homónimos.
   */
  const falta = (r: any) => ({
    overview: SINOPSIS_DE_RELLENO.test(String(r.overview || '')) || !String(r.overview || '').trim(),
    release_date: !String(r.release_date || '').trim(),
    poster: r.poster && !/image\.tmdb\.org|themoviedb\.org/i.test(String(r.poster)),
  });

  const objetivo = rows
    .filter(r => r.tmdb_id > 0 && Object.values(falta(r)).some(Boolean))
    .slice(0, Number.isFinite(limitArg as number) ? limitArg : undefined);

  console.log(`   ${objetivo.length} fichas con ficha de TMDB adoptada y algún hueco\n`);

  let rellenadas = 0;
  let sinRemedio = 0;

  for (let i = 0; i < objetivo.length; i += 6) {
    await Promise.all(objetivo.slice(i, i + 6).map(async row => {
      const d = await TmdbService.getTmdbDetails(row.tmdb_id, row.type).catch(() => null);
      if (!d) { sinRemedio++; return; }

      const hueco = falta(row);
      const update: Record<string, any> = {};

      const texto = String(d.overview || '').trim();
      if (hueco.overview && texto && !SINOPSIS_DE_RELLENO.test(texto)) update.overview = texto;

      const fecha = String(d.release_date || d.first_air_date || '').trim();
      if (hueco.release_date && fecha) update.release_date = fecha;

      if (hueco.poster && d.poster_path) update.poster = `https://image.tmdb.org/t/p/w500${d.poster_path}`;

      // TMDB tampoco lo tiene: no hay nada que arreglar y no debe contarse como pendiente.
      if (Object.keys(update).length === 0) { sinRemedio++; return; }

      rellenadas++;
      if (rellenadas <= 10) {
        console.log(`   ✓ ${String(row.id).slice(0, 40).padEnd(41)} ${Object.keys(update).join(', ')}`);
      }
      if (!apply) return;

      marcarTocada(row);
      const { error } = await db.from('media_items').update(update).eq('id', row.id);
      if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
    }));
  }

  console.log(`\n📝 ${rellenadas} fichas completadas · ${sinRemedio} cuyos huecos TMDB tampoco cubre`);
  console.log(apply ? '   ✅ escritas' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * MODOS DE ENTREGA OBSOLETOS (`--modos`).
 *
 * Cada servidor lleva guardado un `direct_mode` que dice cómo se le va a entregar el vídeo
 * (302 al CDN, manifiesto desde aquí, o reenvío de bytes). Es un ANUNCIO: la decisión real la
 * vuelve a tomar /api/v1/stream/direct al reproducir, así que un valor viejo no rompe la
 * reproducción desde un navegador.
 *
 * Pero sí engaña a los clientes nativos, que leen ese campo para decidir si piden
 * `?mode=redirect` y se ahorran el proxy. Y sobre todo: cada vez que se corrige una política de
 * host, los 16.000 servidores ya guardados se quedan anunciando la política vieja hasta que
 * vuelva a pasar el crawl por cada ficha — semanas.
 *
 * Pasó al descubrir que emturbovid disfraza sus segmentos de PNG: dejó de ser `redirect` y pasó
 * a `proxy`, y las fichas seguían diciendo `redirect`. Esto lo recalcula sin tocar la red —es
 * pura política, `bestMode` sobre la url del embed— así que cuesta lo que una escritura.
 *
 *   npm run repair:catalog -- --modos            # mide
 *   npm run repair:catalog -- --modos --apply    # y los reescribe
 */
async function repairStaleModes(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`🔀 Buscando modos de entrega obsoletos${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const rows = (await fetchAllRows(['servers'])).filter(r => (r.servers || []).length > 0);

  let fichasTocadas = 0;
  let servidoresCambiados = 0;
  const cambios = new Map<string, number>();

  const objetivo = rows.slice(0, Number.isFinite(limitArg as number) ? limitArg : undefined);

  for (const row of objetivo) {
    let cambio = false;
    const servers = (row.servers || []).map((s: any) => {
      if (!s?.embed_url || !s.direct_stream) return s;

      /**
       * SOLO SE TOCA LO QUE ES FALSO PARA CUALQUIER CLIENTE. El resto se deja en paz.
       *
       * `manifest` y `redirect` no son mejores o peores en abstracto: dependen de lo que el
       * cliente sepa hacer, y la ruta lo recalcula en cada reproducción con esa información. Al
       * probar esto sin acotar salían 2.853 cambios `manifest → proxy` de la familia upns —
       * todos a PEOR: `manifest` es exactamente lo que le corresponde a un navegador que manda
       * Referer, y reescribirlo habría metido su vídeo por el proxy sin motivo, pagando tránsito
       * por una "corrección" que empeora.
       *
       * Lo que sí es falso para todos es anunciar un 302 en un host cuya política obliga a
       * proxear pase lo que pase: porque ata por IP, o —el caso de emturbovid— porque sus bytes
       * no son vídeo hasta que se los desenvolvemos aquí. Ahí ningún cliente puede, y el anuncio
       * lleva al cliente nativo a pedir `?mode=redirect` y quedarse sin reproducir.
       *
       * Y `public` es un modo retirado (ya no se publica ninguna url cruda de CDN): esos se
       * recalculan siempre.
       */
      const politica = policyFor(s.embed_url);

      /**
       * Hay hosts cuyo vídeo NO se puede servir desde nuestra red por ninguna vía. Ahí no vale
       * corregir el modo: hay que retirar el anuncio entero y dejar el embed, que sí reproduce.
       *
       * vidhideplus ata la URL a la IP que la acuñó (un 302 al cliente da 403) y a la vez
       * estrangula a las IP de datacenter (el proxy va a ~10 KB/s, cuando no devuelve 502). Se
       * anunciaba como "Vídeo directo", el reproductor lo elegía PRIMERO por estar mejor rotulado
       * y se caía con `fragLoadError` a los diez segundos. Retirarlo no quita ninguna opción: el
       * servidor sigue ahí como embed, que es como funciona.
       */
      if (politica.noSePuedeServirDirecto && s.direct_stream) {
        const { direct_stream, direct_kind, direct_mode, direct_host, headers, ...limpio } = s;
        cambios.set(`${s.direct_mode} → sin vídeo directo`, (cambios.get(`${s.direct_mode} → sin vídeo directo`) || 0) + 1);
        servidoresCambiados++;
        cambio = true;
        return { ...limpio, name: String(s.name || '').replace(/\[Vídeo directo\]/gi, '[Embed]') };
      }

      const obligaProxy = politica.ipBound || politica.segmentosDisfrazados === true;
      const esLegado = s.direct_mode === 'public';
      const anunciaEntregaDirecta = s.direct_mode === 'redirect' || s.direct_mode === 'manifest';
      if (!esLegado && !(obligaProxy && anunciaEntregaDirecta)) return s;

      const modo = bestMode(s.embed_url, s.direct_kind === 'mp4' ? 'mp4' : 'hls');
      if (modo === s.direct_mode) return s;
      cambios.set(`${s.direct_mode} → ${modo}`, (cambios.get(`${s.direct_mode} → ${modo}`) || 0) + 1);
      servidoresCambiados++;
      cambio = true;
      return { ...s, direct_mode: modo };
    });
    if (!cambio) continue;

    fichasTocadas++;
    if (!apply) continue;
    marcarTocada(row);
    const { error } = await db.from('media_items').update({ servers }).eq('id', row.id);
    if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
  }

  console.log(`\n🔀 ${servidoresCambiados} servidores con el modo desactualizado en ${fichasTocadas} fichas`);
  for (const [c, n] of Array.from(cambios).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(6)}  ${c}`);
  }
  console.log(apply ? '   ✅ reescritos' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * FICHAS HUÉRFANAS (`--huerfanas`).
 *
 * Una ficha sin servidores Y SIN NINGUNA PÁGINA DE ORIGEN no es una ficha pendiente de resolver:
 * es una que no puede resolverse nunca. No hay a quién preguntarle por sus enlaces. Aun así salía
 * en el home y en la búsqueda, porque el filtro de fantasmas solo esconde `has_streams = false` y
 * estas lo tienen a `null` — nunca se comprobaron, porque no hay nada que comprobar.
 *
 * Y la mayoría las creé yo: `--fuentes` retira las páginas que pertenecen a OTRA película, y
 * cuando la intrusa era la única que tenía, la ficha se queda vacía. Es correcto quitar la fuente
 * ajena —servir el vídeo de otra película es peor— pero dejar la ficha visible y muerta no.
 *
 * Se marcan como fantasma en vez de borrarlas: el crawl puede volver a encontrarles su página, y
 * entonces `has_streams` se recalcula solo y vuelven a aparecer. Borrarlas perdería su metadata
 * (póster, sinopsis, alias) para nada.
 *
 *   npm run repair:catalog -- --huerfanas
 *   npm run repair:catalog -- --huerfanas --apply
 */
async function hideOrphanRows(apply: boolean): Promise<void> {
  console.log(`👻 Buscando fichas sin servidores y sin ninguna página de origen${apply ? '' : ' (dry-run)'}...`);
  const rows = await fetchAllRows(['servers', 'seasons', 'has_streams']);

  const conServidores = (r: any) =>
    (r.servers || []).length > 0 ||
    (r.seasons || []).some((t: any) => (t.episodes || []).some((e: any) => (e.servers || []).length > 0));
  const conFuente = (r: any) => Boolean(r.source_url) || (r.source_urls || []).length > 0;

  const huerfanas = rows.filter(r => !conServidores(r) && !conFuente(r) && r.has_streams !== false);
  console.log(`   ${huerfanas.length} fichas que no pueden conseguir servidores y aun así se muestran\n`);

  for (const row of huerfanas.slice(0, 12)) {
    console.log(`   ${String(row.id).slice(0, 44).padEnd(45)} "${String(row.title).slice(0, 32)}" [${row.type}]`);
  }

  if (apply) {
    for (const row of huerfanas) {
      marcarTocada(row);
      const { error } = await db.from('media_items').update({ has_streams: false }).eq('id', row.id);
      if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
    }
  }

  console.log(`\n👻 ${huerfanas.length} fichas ${apply ? 'retiradas de los listados' : 'se retirarían'}`);
  console.log(apply ? '   ✅ marcadas' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * FICHAS QUE SOLO PUEDEN OFRECER UN IFRAME (`--sin-directo`).
 *
 * La API dejó de entregar embed: la app cliente no sabe incrustar iframes —lo comprobó el usuario
 * con «31 Minutos: Calurosa Navidad», donde el `embed_url` que viajaba al lado del vídeo directo
 * era una página de blogspot con su propio reproductor dentro— así que ahora sale vídeo directo o
 * no sale nada (`streamSorter.paraElCliente`).
 *
 * Consecuencia: una ficha cuyos servidores son TODOS embed ya no entrega nada, y seguir
 * anunciándola en el home y en la búsqueda es prometer un botón de reproducir que no hace nada.
 * Es el mismo criterio que se aplicó a las huérfanas, con otro motivo.
 *
 * VA EN LOS DOS SENTIDOS, y esa es la mitad importante: también DEVUELVE a los listados las que
 * tienen `has_streams = false` y hoy sí traen vídeo directo. Sin eso, cada pasada escondería un
 * poco más de catálogo y lo que arregla el extractor no volvería nunca — una trampa de un solo
 * sentido. Como el repaso de extracción corre a diario, la recuperación tiene que ser automática.
 *
 * Solo mira fichas que TIENEN servidores guardados. Una sin ninguno no es asunto de este modo: no
 * se sabe si es que no se ha resuelto todavía, y esconderla sería adelantarse al veredicto.
 *
 *   npm run repair:catalog -- --sin-directo
 *   npm run repair:catalog -- --sin-directo --apply
 */
async function hideRowsWithoutDirect(apply: boolean): Promise<void> {
  console.log(`🚫 Buscando fichas cuyos servidores son todos embed${apply ? '' : ' (dry-run)'}...`);
  const rows = await fetchAllRows(['servers', 'seasons', 'has_streams']);

  /** Todo lo reproducible de la ficha: sus servidores y los de cada episodio. */
  const todosLosServidores = (r: any): any[] => [
    ...(r.servers || []),
    ...(r.seasons || []).flatMap((t: any) => (t.episodes || []).flatMap((e: any) => e.servers || [])),
  ];
  /**
   * LA MISMA FUNCIÓN QUE DECIDE QUÉ SALE AL CLIENTE, no una copia de su criterio.
   *
   * Había aquí un `s.direct_stream && s.status !== 'offline'` escrito a mano, y era el criterio de
   * `paraElCliente`… hasta que `paraElCliente` empezó a exigir además que el servidor hubiera
   * demostrado entregar vídeo. Las dos reglas se separaron en silencio y el resultado fue una
   * ficha que se anunciaba sin poder enseñar ni un capítulo: `has_streams` decía que sí porque la
   * copia vieja daba que sí, y la lista salía vacía porque la de verdad daba que no. El usuario lo
   * vio con Breaking Bad — visible, 62 capítulos, ninguno anunciable, cero servidores verificados.
   *
   * Duplicar un criterio es apostar a que nadie lo cambiará nunca. Ahora se llama a la fuente.
   */
  const hayDirecto = (r: any) => veredictoDisponibilidad(r, 'todo') === true;

  const conServidores = rows.filter(r => todosLosServidores(r).length > 0);
  const aEsconder = conServidores.filter(r => !hayDirecto(r) && r.has_streams !== false);
  const aDevolver = conServidores.filter(r => hayDirecto(r) && r.has_streams === false);

  console.log(`   ${conServidores.length} fichas con servidores guardados`);
  console.log(`   ${aEsconder.length} solo tienen embed → se retiran`);
  console.log(`   ${aDevolver.length} ya tienen vídeo directo y estaban escondidas → vuelven\n`);

  for (const row of aEsconder.slice(0, 10)) {
    const hosts = Array.from(new Set(todosLosServidores(row).map(s => {
      try { return new URL(s.embed_url).hostname.replace(/^www\./, ''); } catch { return '?'; }
    }))).slice(0, 3).join(', ');
    console.log(`   − "${String(row.title).slice(0, 34).padEnd(35)}" ${hosts}`);
  }
  for (const row of aDevolver.slice(0, 6)) {
    console.log(`   + "${String(row.title).slice(0, 34).padEnd(35)}" recupera vídeo directo`);
  }

  if (apply) {
    for (const [valor, lote] of [[false, aEsconder], [true, aDevolver]] as [boolean, any[]][]) {
      for (const row of lote) {
        marcarTocada(row);
        const { error } = await db.from('media_items').update({ has_streams: valor }).eq('id', row.id);
        if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
      }
    }
  }

  console.log(`\n🚫 ${aEsconder.length} retiradas · ${aDevolver.length} devueltas ${apply ? '' : '(se harían)'}`);
  console.log(apply ? '   ✅ aplicado' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * COMPROBAR CAPÍTULOS UNO A UNO (`--episodios`).
 *
 * Un capítulo sin nada reproducible no debe anunciarse, y una temporada entera sin capítulos
 * anunciables tampoco. Pero eso solo se puede decidir sobre capítulos COMPROBADOS: los enlaces de
 * un episodio se resuelven al abrirlo, así que en la base de datos la mayoría están vacíos por no
 * haberse pedido nunca, no por estar rotos. Esconder por lista vacía dejaría casi todas las series
 * sin un solo capítulo.
 *
 * Esta pasada es la que convierte «sin comprobar» en un veredicto. Pide cada capítulo de verdad;
 * `getEpisode` scrapea su página, `persistEpisodeServers` guarda lo que salga y sella `checked_at`
 * —con enlaces o sin ellos—, y a partir de ahí `toPublicItem` ya puede esconder los vacíos.
 *
 * Se prioriza lo NUNCA comprobado, y después lo más viejo: así la primera vuelta cubre catálogo
 * nuevo en vez de repasar lo mismo. Ventana acotada por `--limit` porque son decenas de miles de
 * capítulos y esto no termina en una corrida — ni falta.
 *
 *   npm run repair:catalog -- --episodios --limit=200
 *   npm run repair:catalog -- --episodios --apply --limit=200
 */
async function checkEpisodes(apply: boolean, limitArg?: number): Promise<void> {
  const CADUCA_MS = 7 * 24 * 60 * 60 * 1000;
  const tope = Number.isFinite(limitArg as number) && (limitArg as number) > 0 ? (limitArg as number) : 200;
  console.log(`🎞  Comprobando capítulos uno a uno${apply ? '' : ' (dry-run)'} · tope ${tope}\n`);

  type Pendiente = { id: string; title: string; season: number; episode: number; edad: number; visible: boolean; orden: number };
  const pendientes: Pendiente[] = [];

  const PAGINA = 40;
  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,seasons,has_streams')
      .eq('type', 'tvseries')
      /**
       * CON `order`. Un SELECT sin ORDER BY no garantiza el mismo orden entre consultas, así que
       * paginar sin él se salta filas y repite otras — y no se nota, porque el recuento sale
       * plausible y además estable. Con 26 series cabían en una página y daba igual; en cuanto el
       * catálogo pase de `PAGINA` series, empieza a perder series enteras sin decir nada.
       */
      .order('id')
      .range(from, from + PAGINA - 1);
    if (error) { console.warn(`   ⚠ ${error.message}`); break; }
    if (!data || data.length === 0) break;

    for (const row of data as any[]) {
      for (const t of row.seasons || []) {
        for (const e of t?.episodes || []) {
          const sello = e?.checked_at ? Date.parse(e.checked_at) : 0;
          if (sello && Date.now() - sello < CADUCA_MS) continue;
          const season = Number(t.season_number), episode = Number(e.episode_number);
          pendientes.push({
            id: row.id, title: row.title, season, episode,
            edad: sello,                        // 0 = nunca comprobado, va primero
            visible: row.has_streams === true,  // lo que la gente ve HOY
            orden: season * 10000 + episode,    // 1x1 antes que 1x2, y ese antes que 2x1
          });
        }
      }
    }
    if (data.length < PAGINA) break;
  }

  /**
   * EL ORDEN DECIDE CUÁNTO TARDA EN NOTARSE, y con 90.000 pendientes eso pesa más que el ritmo.
   *
   * Se hacía a lo ANCHO —el 1x1 de todas las series antes que el 1x2 de ninguna— y tenía sentido
   * mientras un capítulo sin comprobar se seguía anunciando: repartir el primer capítulo daba algo
   * a todas. Desde que solo se anuncia lo demostrado, eso mismo produce el peor resultado posible:
   * mil series enseñando UN capítulo cada una, que es lo que un espectador lee como una app rota.
   *
   * Ahora se va a lo HONDO, serie por serie, y empezando por las que menos les falta. Una serie
   * termina y aparece entera; la siguiente, después. Se prefiere que veinte series estén completas
   * a que mil estén a medias, y arrancar por las cortas hace que las primeras lleguen en minutos.
   *
   * Las que HOY están en el catálogo van delante: comprobar las que nadie ve no arregla nada
   * visible.
   */
  const faltanPorSerie = new Map<string, number>();
  for (const p of pendientes) faltanPorSerie.set(p.id, (faltanPorSerie.get(p.id) || 0) + 1);
  pendientes.sort((a, b) =>
    (Number(b.visible) - Number(a.visible)) ||
    ((faltanPorSerie.get(a.id) || 0) - (faltanPorSerie.get(b.id) || 0)) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||   // no intercalar dos series con el mismo tamaño
    (a.orden - b.orden)
  );
  const lista = pendientes.slice(0, tope);
  const visibles = pendientes.filter(p => p.visible).length;
  console.log(`   ${pendientes.length} capítulos por comprobar (${visibles} de series visibles) · se hacen ${lista.length}`);

  /**
   * TRES resultados, no dos, y confundirlos da un informe que asusta sin motivo:
   *
   *   ready       el capítulo tiene vídeo.
   *   unavailable se encontró su página, se miraron sus servidores y ninguno sirve. Queda sellado
   *               y DEJA DE ANUNCIARSE.
   *   pending     no se encontró página del capítulo. NO se sella —puede ser un fallo de red o un
   *               slug que no existe— así que el capítulo se sigue anunciando igual que antes.
   *
   * Contar juntos los dos últimos hacía parecer que se iba a esconder el 75% del catálogo cuando
   * la mayoría son `pending`, que no esconden nada.
   */
  let conVideo = 0, vacios = 0, sinPagina = 0;
  // Seis a la vez: cada capítulo es una página de la fuente más el sondeo de sus servidores, y con
  // 89.950 pendientes el ritmo decide si la vuelta completa son días o meses. Por encima de esto
  // las fuentes empiezan a contestar 429 y la pasada mide humo (ver `--servidores-muertos`).
  const CONC = 6;
  for (let i = 0; i < lista.length; i += CONC) {
    await Promise.all(lista.slice(i, i + CONC).map(async c => {
      if (!apply) return;   // `getEpisode` escribe al resolver: en dry-run no se le llama
      const ep = await CatalogService.getEpisode(c.id, c.season, c.episode).catch(() => null);
      const estado = ep?.streams?.status;
      if (estado === 'ready') conVideo++;
      else if (estado === 'unavailable') vacios++;
      else sinPagina++;
    }));
    if ((i + CONC) % 80 < CONC) console.log(`   ${Math.min(i + CONC, lista.length)}/${lista.length} · ${conVideo} con vídeo · ${vacios} vacíos`);
  }

  if (apply) {
    console.log(`\n🎞  ${conVideo} capítulos con vídeo · ${vacios} comprobados y vacíos (dejan de anunciarse)`);
    console.log('   ✅ aplicado');
  } else {
    console.log('   (dry-run: no se ha pedido ningún capítulo. Repite con --apply)');
  }
}

/**
 * ENLACES PRESTADOS ENTRE CAPÍTULOS (`--episodios-prestados`).
 *
 * `inheritServersToEpisodes` rellenaba los episodios sin enlaces propios con los de nivel serie, y
 * como `persistStreams` escribe `seasons`, esos enlaces quedaron GUARDADOS como si fueran del
 * capítulo. El código ya no lo hace; esto limpia lo que dejó escrito.
 *
 * CÓMO SE RECONOCE UNO PRESTADO, sin adivinar: dos capítulos distintos no pueden tener el mismo
 * `embed_url`, porque un embed es UN vídeo. Si el mismo aparece en más de un episodio de la misma
 * serie, no es de ninguno de los dos — es el de la serie repartido a todos. Medido: 2.529 de 2.588
 * series con enlaces de episodio guardados, 83.485 episodios afectados. «El Chapulín Colorado»
 * servía el último capítulo en los 289.
 *
 * Se quitan de TODOS los episodios, no de todos menos uno: no hay forma de saber a cuál pertenecía
 * de verdad, y dejarlo en el equivocado es exactamente el fallo que se está arreglando.
 *
 * NO SE TOCA `has_streams`, y es deliberado. El episodio se queda sin enlaces guardados, pero al
 * abrirlo `getEpisode` scrapea SU página y `persistEpisodeServers` deja los correctos escritos. Si
 * aquí se recalculara la visibilidad sobre lo que acabamos de vaciar, se escondería el catálogo de
 * series entero para que volviera solo unas horas después — el mismo error de la migración 007.
 *
 *   npm run repair:catalog -- --episodios-prestados
 *   npm run repair:catalog -- --episodios-prestados --apply
 */
async function purgeBorrowedEpisodeServers(apply: boolean): Promise<void> {
  console.log(`🔗 Buscando enlaces repetidos entre capítulos${apply ? '' : ' (dry-run)'}...`);

  // Páginas PEQUEÑAS: `seasons` es un JSONB grande y pedir 400 filas de golpe hace que Postgres
  // aborte por `statement timeout`. Con 40 va sobrado y no se nota.
  const PAGINA = 40;
  let series = 0, tocadas = 0, episodiosLimpiados = 0, servidoresQuitados = 0;
  const ejemplos: string[] = [];

  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,seasons')
      .eq('type', 'tvseries')
      .range(from, from + PAGINA - 1);
    if (error) { console.warn(`   ⚠ ${error.message}`); break; }
    if (!data || data.length === 0) break;

    for (const row of data as any[]) {
      const temporadas: any[] = row.seasons || [];
      const episodios: any[] = temporadas.flatMap(t => t?.episodes || []);
      if (!episodios.some(e => (e?.servers || []).length > 0)) continue;
      series++;

      const veces = new Map<string, number>();
      for (const e of episodios) {
        for (const sv of e?.servers || []) if (sv?.embed_url) veces.set(sv.embed_url, (veces.get(sv.embed_url) || 0) + 1);
      }
      const prestado = (sv: any) => sv?.embed_url && (veces.get(sv.embed_url) || 0) > 1;
      if (![...veces.values()].some(n => n > 1)) continue;

      let quitados = 0, epsTocados = 0;
      const seasons = temporadas.map(t => ({
        ...t,
        episodes: (t?.episodes || []).map((e: any) => {
          const antes: any[] = e?.servers || [];
          const despues = antes.filter(sv => !prestado(sv));
          if (despues.length === antes.length) return e;
          quitados += antes.length - despues.length;
          epsTocados++;
          return { ...e, servers: despues, primary_stream: null };
        }),
      }));

      tocadas++;
      episodiosLimpiados += epsTocados;
      servidoresQuitados += quitados;
      if (ejemplos.length < 8) {
        const peor = [...veces.entries()].sort((a, b) => b[1] - a[1])[0];
        ejemplos.push(`${String(row.title).slice(0, 34).padEnd(36)} un enlace estaba en ${peor[1]} capítulos`);
      }

      if (!apply) continue;
      marcarTocada(row);
      const { error: err } = await db.from('media_items').update({ seasons }).eq('id', row.id);
      if (err) console.warn(`   ⚠ ${row.id}: ${err.message}`);
    }

    if (from % 400 === 0) console.log(`   ${from + data.length} series revisadas · ${tocadas} con enlaces prestados`);
    if (data.length < PAGINA) break;
  }

  console.log(`\n🔗 ${series} series con enlaces de episodio · ${tocadas} tenían prestados`);
  console.log(`   ${episodiosLimpiados} episodios limpiados · ${servidoresQuitados} enlaces retirados\n`);
  for (const e of ejemplos) console.log(`   · ${e}`);
  console.log(apply ? '\n   ✅ aplicado' : '\n   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * VERIFICAR QUE LO PUBLICADO ENTREGA VÍDEO DE VERDAD (`--verificar`).
 *
 * `--servidores-muertos` usa `inspectEmbed`, que comprueba si la PÁGINA del reproductor carga. Una
 * página puede cargar impecable y no tener vídeo detrás: es exactamente lo que hacía la familia
 * upns —su API contestaba 200 sin un solo campo de CDN— y lo que deja pasar a un `direct_stream`
 * que al reproducir da 502. Aquí se usa `comprobarEmbed`, que acuña el enlace, baja el manifiesto,
 * revisa las variantes y **descarga un segmento real**. Es la misma comprobación que hace el
 * reproductor, no una aproximación.
 *
 * Y MIRA DENTRO DE LOS EPISODIOS. Los servidores de una serie viven en
 * `seasons[].episodes[].servers`, donde ni `--servidores-muertos` ni `--directos-falsos` han
 * entrado nunca; por eso las series eran las que peor reproducían.
 *
 * Lo que se escribe:
 *   vivo        → `verified_at` con la fecha. Es el sello que permitirá publicar solo lo probado.
 *   muerto      → se le quitan los campos de vídeo directo y baja a `offline` (no se borra: el
 *                 embed sigue ahí para reextraer, y `resucitarCaidos` puede absolverlo).
 *   desconocido → NO se toca. No poder demostrar algo no es demostrar lo contrario.
 *
 * Se reutiliza el reparto por turnos entre hosts de `--servidores-muertos`: sin él, diez sondas
 * seguidas al mismo sitio devuelven 429 y la pasada mide humo.
 *
 *   npm run repair:catalog -- --verificar --limit=400
 *   npm run repair:catalog -- --verificar --apply --limit=400
 */
async function verifyPlayableServers(apply: boolean, limitArg?: number, soloHost?: string): Promise<void> {
  console.log(`🎬 Comprobando que lo publicado entrega vídeo${apply ? '' : ' (dry-run)'}...`);
  const rows = await fetchAllRows(['servers', 'seasons', 'has_streams']);
  const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(ilegible)'; } };

  /** Todos los servidores de una ficha: los suyos y los de cada episodio. */
  const servidoresDe = (r: any): any[] => [
    ...(r.servers || []),
    ...(r.seasons || []).flatMap((t: any) => (t.episodes || []).flatMap((e: any) => e.servers || [])),
  ];

  /**
   * Un mismo embed aparece en muchas fichas y en muchos episodios: se comprueba UNA vez. Se
   * guarda además su sello MÁS FRESCO, que es lo que decide si hoy se puede publicar.
   */
  const pendientes = new Map<string, number>();
  for (const row of rows) {
    for (const s of servidoresDe(row)) {
      if (!s?.embed_url || !s.direct_stream) continue;
      if (soloHost && !hostDe(s.embed_url).includes(soloHost)) continue;
      const sello = s.verified_at ? Date.parse(s.verified_at) : 0;
      const previo = pendientes.get(s.embed_url);
      const valido = Number.isFinite(sello) ? sello : 0;
      if (previo === undefined || valido > previo) pendientes.set(s.embed_url, valido);
    }
  }
  console.log(`   ${pendientes.size} embeds distintos publicados como vídeo directo`);

  /**
   * PRIMERO LO QUE ESTÁ A PUNTO DE CADUCAR. Aquí estaba el fallo, y era de orden.
   *
   * Esto recorría la lista con `.sort()`, o sea POR ORDEN ALFABÉTICO DE URL, que no tiene nada
   * que ver con la urgencia. Mientras la vuelta entera quepa en el tiempo disponible da igual —
   * pero en cuanto una corrida se queda corta (el tope de 170 min, el runner que se apaga, un
   * host lento), la parte que se queda sin comprobar es SIEMPRE LA MISMA COLA DEL ALFABETO. Esos
   * sellos caducan, la ficha desaparece del catálogo, reaparece cuando por fin le toca el turno,
   * y vuelve a caducar. Un título que va y viene es peor que uno que no está: quien lo vio ayer
   * no entiende por qué hoy no existe.
   *
   * Ordenando por sello —lo más viejo delante, y lo que no se ha comprobado nunca el primero de
   * todos— el fallo deja de ser un agujero y pasa a ser un retraso: una vuelta a medias hace
   * exactamente la mitad que corría peligro, y lo que se queda sin mirar es lo que se selló hace
   * un rato y aún tiene horas de validez por delante. Ninguna corrida parcial deja caducar nada
   * mientras el atraso quepa dentro de la ventana del sello.
   *
   * El reparto por turnos entre hosts se conserva ENCIMA de este orden, y no es opcional: diez
   * sondas seguidas al mismo sitio devuelven 429 y la pasada mide humo.
   */
  const porUrgencia = Array.from(pendientes.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([url]) => url);

  const porHostCola = new Map<string, string[]>();
  for (const url of porUrgencia) {
    const h = hostDe(url);
    (porHostCola.get(h) || porHostCola.set(h, []).get(h)!).push(url);
  }
  const todos: string[] = [];
  for (let fila = 0; todos.length < pendientes.size; fila++) {
    for (const cola of porHostCola.values()) if (fila < cola.length) todos.push(cola[fila]);
  }

  const lote = Number.isFinite(limitArg as number) ? (limitArg as number) : 0;
  let lista = todos;
  if (lote > 0 && lote < todos.length) {
    /**
     * Y con `--limit` se cogen LOS PRIMEROS, no una ventana que va rotando por días.
     *
     * La ventana rotatoria existía para garantizar que, a base de corridas, se acabara pasando
     * por todos. Con la lista ordenada por urgencia eso ya está garantizado, y mejor: los que más
     * lo necesitan van delante en CADA corrida, sin esperar a que el calendario les dé su turno.
     * La ventana tenía además el defecto de siempre — un día le tocaba un tramo con los sellos
     * recién puestos y gastaba la corrida entera comprobando lo ya comprobado.
     */
    lista = todos.slice(0, lote);
  }

  const desdeSello = (ms: number) => ms === 0 ? 'nunca' : `hace ${((Date.now() - ms) / 3600000).toFixed(1)} h`;
  const masViejo = porUrgencia.length ? pendientes.get(porUrgencia[0])! : 0;
  console.log(`   ${lista.length} por comprobar · el más atrasado se selló ${desdeSello(masViejo)}\n`);

  /**
   * El tope era 20 y se midió en producción que no llega: 4.547 servidores tardaron 95 minutos y
   * la corrida murió en el minuto 90 con 4.400 hechos. Cada comprobación baja hasta un segmento
   * real, así que son ~24 s de reloj cada una y lo único que las acorta es hacer más a la vez.
   *
   * Sube a 32, no más: lo que provoca los 429 no es el total en vuelo sino cuántas caen sobre el
   * MISMO host, y eso lo sigue gobernando el reparto por turnos —dos por host— de más arriba.
   */
  const CONCURRENCIA = Math.max(2, Math.min(32, porHostCola.size * 2));
  const veredictos = new Map<string, 'vivo' | 'muerto'>();
  let vivos = 0, muertos = 0, dudosos = 0;

  async function escribirLoDecidido(): Promise<void> {
    for (const row of rows) {
      let cambio = false;
      const sello = new Date().toISOString();

      const revisar = (s: any) => {
        const v = s?.embed_url ? veredictos.get(s.embed_url) : undefined;
        if (!v || !s.direct_stream) return s;
        if (v === 'muerto') { cambio = true; return { ...sinVideoDirecto(s), status: 'offline', name: nombreConTipo(s.name, false) }; }
        if (s.verified_at === sello) return s;
        cambio = true;
        return { ...s, verified_at: sello, status: 'online' };
      };

      const servers = (row.servers || []).map(revisar);
      const seasons = (row.seasons || []).map((t: any) => ({
        ...t,
        episodes: (t.episodes || []).map((e: any) => (
          Array.isArray(e?.servers) ? { ...e, servers: e.servers.map(revisar) } : e
        )),
      }));
      if (!cambio) continue;

      row.servers = servers; row.seasons = seasons;   // que la siguiente tanda no lo repita
      if (!apply) continue;
      marcarTocada(row);
      const reproducible = veredictoDisponibilidad({ type: row.type, servers, seasons }, 'parcial') ?? row.has_streams;
      const { error } = await db.from('media_items')
        .update({ servers, seasons, has_streams: reproducible, streams_checked_at: sello })
        .eq('id', row.id);
      if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
    }
  }

  let hechos = 0;
  for (let i = 0; i < lista.length; i += CONCURRENCIA) {
    await Promise.all(lista.slice(i, i + CONCURRENCIA).map(async url => {
      try {
        /**
         * TRES SEGMENTOS CONSECUTIVOS, no uno. El barrido es quien pone el sello, y un sello
         * puesto sobre un solo segmento sellaba hosts que el espectador veía morir enseguida:
         * el primero suele estar caliente en el borde del CDN y se sirve solo. Aquí sí se puede
         * pagar —son dos peticiones más de 8 KB— porque no hay nadie esperando delante.
         *
         * El presupuesto sube de 30 a 40 s para que quepan: quedarse sin tiempo no suspende a
         * nadie (`segmentoDescargable` deja pasar lo que no le dio tiempo a mirar), pero sí
         * desaprovecha la comprobación.
         */
        const c = await comprobarEmbed(url, { limite: Date.now() + 40000, segmentosExigidos: 3 });
        if (c.veredicto === 'vivo') { veredictos.set(url, 'vivo'); vivos++; }
        else if (c.veredicto === 'muerto' && c.universal) { veredictos.set(url, 'muerto'); muertos++; }
        else dudosos++;
      } catch { dudosos++; }
    }));
    hechos += Math.min(CONCURRENCIA, lista.length - i);
    if (hechos % 200 < CONCURRENCIA) {
      await escribirLoDecidido();
      console.log(`   ${hechos}/${lista.length} · ${vivos} entregan vídeo · ${muertos} muertos · ${dudosos} sin veredicto`);
    }
  }
  await escribirLoDecidido();

  const tot = vivos + muertos + dudosos || 1;
  console.log(`\n🎬 ${vivos} entregan vídeo (${((vivos / tot) * 100).toFixed(0)}%) · ${muertos} muertos · ${dudosos} sin veredicto`);
  console.log(apply ? '   ✅ aplicado' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * SERIES ESCONDIDAS QUE SÍ SE VEN (`--series-ocultas`).
 *
 * `has_streams` se calcula con lo GUARDADO, y hasta ahora una serie no guardaba nada: sus
 * capítulos se resolvían al abrirla y se tiraban. Así que en la base de datos toda serie parecía
 * vacía, y el recuento de la migración 007 escondió a las que reproducen igual. Medido sobre 14
 * series ocultas al azar: 6 reproducían.
 *
 * Aquí se les abre un capítulo DE VERDAD. Ya no hace falta escribir nada a mano: desde que
 * `getEpisode` persiste lo que resuelve (`persistEpisodeServers`), resolver el 1x1 deja el árbol
 * escrito y `has_streams` recalculado. Esta pasada solo elige a quién preguntar y a qué ritmo.
 *
 * Se prueban varios capítulos porque un 1x1 caído no significa que la serie entera lo esté.
 *
 *   npm run repair:catalog -- --series-ocultas --limit=50          # solo mide
 *   npm run repair:catalog -- --series-ocultas --apply --limit=200 # y las devuelve
 */
async function recoverHiddenSeries(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`📺 Buscando series escondidas que sí reproducen${apply ? '' : ' (dry-run)'}...`);

  const { data, error } = await db
    .from('media_items')
    .select('id,title')
    .eq('type', 'tvseries')
    .eq('has_streams', false)
    .limit(Number.isFinite(limitArg as number) && (limitArg as number) > 0 ? (limitArg as number) : 100);
  if (error) { console.error(`   ⚠ ${error.message}`); return; }
  const filas = (data || []) as any[];
  console.log(`   ${filas.length} series ocultas a revisar
`);

  let recuperadas = 0, siguenSinNada = 0;
  const CONC = 4;

  for (let i = 0; i < filas.length; i += CONC) {
    await Promise.all(filas.slice(i, i + CONC).map(async row => {
      // Tres capítulos: que el 1x1 esté caído no condena a la serie entera.
      for (const [t, e] of [[1, 1], [1, 2], [1, 3]] as const) {
        const ep = await CatalogService.getEpisode(row.id, t, e).catch(() => null);
        if (ep?.streams?.status !== 'ready') continue;
        recuperadas++;
        marcarTocada(row);
        console.log(`   + "${String(row.title).slice(0, 40).padEnd(42)}" reproduce en ${t}x${e}`);
        // `getEpisode` ya ha escrito seasons y has_streams al persistir. En dry-run se deshace,
        // porque medir no puede cambiar el catálogo.
        if (!apply) await db.from('media_items').update({ has_streams: false }).eq('id', row.id);
        return;
      }
      siguenSinNada++;
    }));
    if ((i + CONC) % 40 < CONC) console.log(`   ${Math.min(i + CONC, filas.length)}/${filas.length}...`);
  }

  console.log(`
📺 ${recuperadas} vuelven al catálogo · ${siguenSinNada} siguen sin nada reproducible`);
  console.log(apply ? '   ✅ aplicado' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * RECONCILIAR LO GUARDADO CON LA POLÍTICA DE HOSTS (`--politica`).
 *
 * `noSePuedeServirDirecto` solo actúa en el momento de scrapear: `describeDirect` y
 * `deferredDirectFields` devuelven `{}` y el servidor nace sin vídeo directo. Pero las filas que YA
 * están en la base de datos conservan su `direct_stream` de cuando el host sí se anunciaba, y de
 * ahí sale `has_streams`, el orden de la lista y el `primary_stream`. O sea que marcar un host en
 * `hostPolicy` no arregla nada de lo ya escrito hasta que a esa ficha le toque un re-scrapeo.
 *
 * Esta pasada cierra ese hueco: recorre lo guardado y le quita los campos de vídeo directo a todo
 * servidor cuyo host ya no se puede servir. No sale a la red ni una vez — el veredicto es la tabla
 * de políticas, que es determinista— así que repasar el catálogo entero cuesta lo que leerlo.
 *
 * Y MIRA TAMBIÉN DENTRO DE LOS EPISODIOS, que es donde está el problema: `--directos-falsos` solo
 * recorre `servers`, y los enlaces de una serie viven en `seasons[].episodes[].servers`.
 *
 * NO toca `has_streams`: la visibilidad la decide `--sin-directo`, que sabe devolver fichas
 * además de esconderlas, y que conviene pasar después de un refresco.
 *
 *   npm run repair:catalog -- --politica            # solo mide
 *   npm run repair:catalog -- --politica --apply    # y los limpia
 */
async function reconcilePolicyDirects(apply: boolean): Promise<void> {
  console.log(`🧭 Reconciliando lo guardado con hostPolicy${apply ? '' : ' (dry-run)'}...`);
  const rows = await fetchAllRows(['servers', 'seasons', 'has_streams']);

  const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(?)'; } };
  /** Se anuncia como vídeo directo pero su host ya no se puede servir desde aquí. */
  const sobra = (s: any) => Boolean(s?.direct_stream) && policyFor(s.embed_url || '').noSePuedeServirDirecto;
  const limpiar = (s: any) => ({ ...sinVideoDirecto(s), name: nombreConTipo(s.name, false) });

  const porHost = new Map<string, number>();
  let filasTocadas = 0, servidoresLimpiados = 0, episodiosTocados = 0;
  let seEsconden = 0;

  for (const row of rows) {
    let cambio = false;

    const servers = (row.servers || []).map((s: any) => {
      if (!sobra(s)) return s;
      cambio = true; servidoresLimpiados++;
      porHost.set(hostDe(s.embed_url), (porHost.get(hostDe(s.embed_url)) || 0) + 1);
      return limpiar(s);
    });

    const seasons = (row.seasons || []).map((t: any) => ({
      ...t,
      episodes: (t.episodes || []).map((e: any) => {
        if (!(e.servers || []).some(sobra)) return e;
        cambio = true; episodiosTocados++;
        return {
          ...e,
          servers: (e.servers || []).map((s: any) => {
            if (!sobra(s)) return s;
            servidoresLimpiados++;
            porHost.set(hostDe(s.embed_url), (porHost.get(hostDe(s.embed_url)) || 0) + 1);
            return limpiar(s);
          }),
        };
      }),
    }));

    if (!cambio) continue;
    filasTocadas++;

    // Mismo criterio que `CatalogService.hasPlayableDirectStream`, pero SOLO PARA INFORMAR.
    const reproducible = [
      ...servers,
      ...seasons.flatMap((t: any) => (t.episodes || []).flatMap((e: any) => e.servers || [])),
    ].some((s: any) => s?.direct_stream && s.status !== 'offline');
    if (!reproducible && row.has_streams !== false) seEsconden++;

    if (apply) {
      marcarTocada(row);
      const { error } = await db
        .from('media_items')
        .update({ servers, seasons })
        .eq('id', row.id);
      if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
    }
  }

  console.log(`\n   ${filasTocadas} fichas con algo que limpiar · ${servidoresLimpiados} servidores · ${episodiosTocados} episodios`);
  console.log('   por host:');
  for (const [h, n] of [...porHost].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${h.padEnd(32)} ${String(n).padStart(6)}`);
  }
  console.log(`\n   ${seEsconden} de ellas se quedarían sin nada reproducible EN LO GUARDADO.`);
  console.log('   NO se les toca `has_streams` aquí, y es deliberado: este recuento sale de lo que');
  console.log('   hay escrito, y una serie resuelve sus episodios EN VIVO al abrirla —puede sacar de');
  console.log('   la fuente un servidor que sí se sirve—. Esconderlas por lo guardado enterraría');
  console.log('   títulos que se ven. Quien decide visibilidad es `--sin-directo`, que además sabe');
  console.log('   devolverlas, y conviene pasarlo DESPUÉS de un refresco con `--deep`.');
  console.log(apply ? '\n   ✅ aplicado' : '\n   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * VÍDEOS DIRECTOS QUE NO LO SON (`--directos-falsos`).
 *
 * Un servidor rotulado "Vídeo directo" cuyo endpoint contesta 502 es la peor opción que puede
 * haber en una ficha: el reproductor lo elige PRIMERO justo por estar mejor rotulado, se come el
 * fallo, y solo entonces cae al embed. Desde fuera se ve como "el directo redirige al embed".
 *
 * Auditados los hosts uno a uno contra producción (scripts/dev/probe_directos_falsos.ts), ninguno
 * devuelve una página HTML —o sea que no se está anunciando un embed como vídeo— pero varios dan
 * 502 al acuñar: `vidnest.io` y `vidnest.live` fallan 3 de 3, `barmonrey` 3 de 3, y hay fallos
 * sueltos en hosts grandes.
 *
 * SE PRUEBA DOS VECES antes de retirar nada, y esa es la parte que importa. Un 502 puede ser un
 * 429 pasajero del host o un timeout, y quitarle el vídeo directo a un servidor bueno por una
 * mala racha es cambiar un problema por otro. Solo se retira lo que falla las dos veces.
 *
 * No se borra el servidor: se le quitan los campos de vídeo directo y se queda como embed, que es
 * lo que de verdad es. Si mañana su extractor vuelve a funcionar, el repaso se los devuelve.
 *
 *   npm run repair:catalog -- --directos-falsos [--host=vidnest] [--limit=N]
 *   npm run repair:catalog -- --directos-falsos --apply
 */
async function repairFakeDirects(apply: boolean, limitArg?: number, soloHost?: string): Promise<void> {
  const API = process.env.API_BASE || 'https://api-pelis-series-latino-gilt.vercel.app';
  console.log(`🎭 Comprobando los que se anuncian como vídeo directo${apply ? '' : ' (dry-run)'}...`);

  const rows = (await fetchAllRows(['servers'])).filter(r => (r.servers || []).length > 0);
  const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(?)'; } };

  const objetivo = new Set<string>();
  for (const row of rows) {
    for (const s of row.servers || []) {
      if (!s?.embed_url || !s.direct_stream) continue;
      if (soloHost && !hostDe(s.embed_url).includes(soloHost)) continue;
      objetivo.add(s.embed_url);
    }
  }
  const lista = Array.from(objetivo).sort().slice(0, Number.isFinite(limitArg as number) ? limitArg : undefined);
  console.log(`   ${lista.length} embeds distintos que anuncian vídeo directo\n`);

  /** ¿El endpoint entrega algo reproducible? Se le da una segunda oportunidad antes de condenar. */
  const entrega = async (embedUrl: string): Promise<boolean> => {
    const enlace = `${API}/api/v1/stream/direct?e=${Buffer.from(embedUrl, 'utf8').toString('base64url')}`;
    for (let intento = 0; intento < 2; intento++) {
      try {
        const r = await streamClient.get(enlace, {
          headers: { Range: 'bytes=0-2047' },
          responseType: 'arraybuffer',
          timeout: 25000,
          validateStatus: () => true,
          maxRedirects: 3,
        });
        if (r.status < 400) return true;
      } catch { /* se reintenta */ }
    }
    return false;
  };

  const falsos = new Set<string>();
  const CONC = 8;
  /**
   * SE PARA A TIEMPO PARA PODER ESCRIBIR LO QUE HA APRENDIDO.
   *
   * Esta pasada junta sus veredictos en memoria y escribe AL FINAL, y su trabajo lleva semanas
   * muriendo antes de llegar ahí: «The runner has received a shutdown signal», que es un fallo
   * conocido y sin explicación en este repositorio (ver la cabecera de reproducible.yml). El
   * 2026-08-19 iba por 1.600/2.500 con **369 falsos ya detectados** cuando el runner se apagó, y
   * los 369 se perdieron enteros.
   *
   * Eso no es una pérdida abstracta: cada uno de esos es un servidor rotulado «Vídeo directo» que
   * el reproductor elige PRIMERO por estar mejor rotulado, y que carga el manifiesto, enseña la
   * duración y revienta al pedir el primer segmento. Es exactamente el «carga un frame, sale la
   * duración y da error» que se reportó con «El show de Truman».
   *
   * Con un presupuesto propio, quedarse a medias deja de costar todo el trabajo: se comprueba lo
   * que cabe, se retira lo demostrado y la próxima corrida sigue por donde toque. Comprobar menos
   * y escribirlo vale más que comprobar todo y perderlo.
   */
  const minutosTope = Number((process.argv.find(a => a.startsWith('--minutos=')) || '').split('=')[1]) || 90;
  const limiteTiempo = Date.now() + minutosTope * 60_000;
  let comprobados = 0;
  for (let i = 0; i < lista.length; i += CONC) {
    if (Date.now() > limiteTiempo) {
      console.log(`   ⏱ agotado el presupuesto de ${minutosTope} min: ${comprobados}/${lista.length} comprobados.`);
      console.log(`      Se retira lo demostrado hasta aquí; el resto sale en la próxima corrida.`);
      break;
    }
    await Promise.all(lista.slice(i, i + CONC).map(async u => { if (!(await entrega(u))) falsos.add(u); }));
    comprobados = Math.min(i + CONC, lista.length);
    if (comprobados % 400 < CONC) console.log(`   ${comprobados}/${lista.length} · ${falsos.size} falsos`);
  }

  const porHost = new Map<string, number>();
  for (const u of falsos) porHost.set(hostDe(u), (porHost.get(hostDe(u)) || 0) + 1);

  /**
   * FRENO DE EMERGENCIA: un apagón total de un host no son mil vídeos borrados a la vez.
   *
   * El umbral está en 95 % con 50 muestras mínimo, y esa cifra tan alta es a propósito. La
   * tentación es ponerlo en el 70 %, y sería un error: emturbovid falla ~75 % y en su caso está
   * BIEN retirarlo, porque se comprobó uno a uno y su contenido está muerto de verdad —manifiestos
   * de 25 bytes sin una sola variante, variantes que dan 404, subdominios de CDN que ya no
   * resuelven—. Un host puede tener tres cuartas partes de su catálogo borrado y seguir siendo un
   * host sano; lo que no puede es fallar el 100 % y que sea casualidad.
   *
   * Cuidado con la trampa que casi me hace poner el umbral bajo: comprobé esos embeds "desde
   * fuera", vi que `extractDirect` devolvía una URL, y concluí que estaban vivos y que el 502 era
   * un bloqueo por IP. Extraer una URL no es encontrar un vídeo. Hay que BAJAR hasta los segmentos
   * —`scripts/dev/probe_emturbovid.ts` lo hace— o se acaba defendiendo un catálogo de fantasmas.
   *
   * Y aunque no frene, la tabla por host se imprime siempre: es lo que convierte "he retirado
   * 2.000 servidores" en "este host se ha caído entero", que es una noticia distinta.
   */
  const muestrasPorHost = new Map<string, number>();
  for (const u of lista) muestrasPorHost.set(hostDe(u), (muestrasPorHost.get(hostDe(u)) || 0) + 1);

  const APAGON = 0.95;
  const MUESTRAS_MINIMAS = 50;
  const hostsApagados = new Set<string>();
  for (const [host, fallos] of porHost) {
    const total = muestrasPorHost.get(host) || 0;
    if (total >= MUESTRAS_MINIMAS && fallos / total >= APAGON) hostsApagados.add(host);
  }

  if (hostsApagados.size) {
    console.log('\n⛔ HOSTS CAÍDOS AL COMPLETO — no se toca ni uno de sus servidores:');
    for (const host of hostsApagados) {
      const total = muestrasPorHost.get(host) || 0;
      console.log(`   ${host.padEnd(30)} ${porHost.get(host)}/${total} fallan (${Math.round((porHost.get(host)! / total) * 100)} %)`);
    }
    console.log('   Fallar el 100 % no es contenido borrado: es el host, o somos nosotros.');
    console.log('   Compruébalo con scripts/dev/probe_emturbovid.ts --host=<host>, que baja hasta');
    console.log('   los segmentos, y vuelve a lanzarlo cuando el host reviva.');
    for (const u of Array.from(falsos)) if (hostsApagados.has(hostDe(u))) falsos.delete(u);
  }

  let servidoresLimpiados = 0;
  let fichasTocadas = 0;
  for (const row of rows) {
    let cambio = false;
    const servers = (row.servers || []).map((s: any) => {
      if (!s?.embed_url || !s.direct_stream || !falsos.has(s.embed_url)) return s;
      const { direct_stream, direct_kind, direct_mode, direct_host, headers, ...limpio } = s;
      cambio = true;
      servidoresLimpiados++;
      return { ...limpio, name: String(s.name || '').replace(/\[Vídeo directo\]/gi, '[Embed]') };
    });
    if (!cambio) continue;
    fichasTocadas++;
    if (!apply) continue;
    marcarTocada(row);
    const { error } = await db.from('media_items').update({ servers }).eq('id', row.id);
    if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
  }

  console.log('\n🎭 Por host:');
  for (const [h, n] of Array.from(porHost).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${h.padEnd(30)} ${String(n).padStart(5)} embeds que no entregan vídeo`);
  }
  console.log(`\n🎭 ${servidoresLimpiados} servidores dejan de anunciar vídeo directo, en ${fichasTocadas} fichas`);
  console.log(apply ? '   ✅ aplicado' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * ¿SE PUEDE ENTREGAR DESDE DONDE SE SIRVE? (`--entrega`)
 *
 * EL EXAMEN SE HACÍA EN UN SITIO Y LA ENTREGA OCURRE EN OTRO, y ese desajuste es la última razón
 * por la que un título podía anunciarse y no reproducirse.
 *
 * `--verificar` corre en GitHub Actions y comprueba el host DIRECTAMENTE: se descarga un segmento
 * y lo sella. La reproducción de verdad no va por ahí —va del móvil a Vercel y de Vercel al
 * host—, así que un host que atiende a GitHub y no a Vercel aprueba con nota y falla en el
 * reproductor. Ningún filtro del catálogo puede verlo, porque quien lo comprueba no es quien lo
 * sirve.
 *
 * Lo reportó el usuario con «Borrón y Vida Nueva»: sellada hacía SEIS MINUTOS, con vídeo real
 * descargado, y su vidnest.io devolviendo 502 al pedirla por el camino bueno.
 *
 * Aquí se pregunta por el camino BUENO: se piden los primeros 64 KB a `/api/v1/stream/direct` de
 * la API de producción, que es exactamente lo que hace ExoPlayer al pulsar Reproducir.
 *
 * Y SE PREGUNTA POR HOST, NO POR SERVIDOR. Que Vercel alcance o no a un sitio es propiedad del
 * sitio, no de cada fichero: da igual cuál de los 1.126 emturbovid se pruebe. Son 15 hosts, así
 * que la vuelta entera cuesta unas pocas peticiones en vez de 4.281 — y sin esa reducción no
 * sería viable, porque cada una mueve bytes de verdad por la API.
 *
 * Se prueban varios representantes por host antes de condenarlo: un fichero puede estar roto sin
 * que lo esté el sitio. Solo si NINGUNO entrega se da el host por inalcanzable.
 *
 * QUÉ SE HACE CON UN HOST INALCANZABLE: se le quita el SELLO a sus servidores, no el
 * `direct_stream`. La diferencia es deliberada — no se destruye nada de lo scrapeado, solo se
 * retira la prueba, que es lo que `paraElCliente` exige para publicar. Las fichas que se quedan
 * sin nada dejan de anunciarse, y en cuanto el host vuelva a atender, la siguiente pasada de
 * `--verificar` los sella otra vez y regresan solos.
 *
 *   npm run repair:catalog -- --entrega
 *   npm run repair:catalog -- --entrega --apply
 */
async function checkDeliveryByHost(apply: boolean): Promise<void> {
  const API = (process.env.API_BASE_URL || 'https://api-pelis-series-latino-gilt.vercel.app').replace(/\/+$/, '');
  console.log(`🚚 Comprobando la entrega REAL por host, contra ${API}${apply ? '' : ' (dry-run)'}...`);

  const rows = await fetchAllRows(['servers', 'seasons', 'has_streams']);
  const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(ilegible)'; } };
  const servidoresDe = (r: any): any[] => [
    ...(r.servers || []),
    ...(r.seasons || []).flatMap((t: any) => (t.episodes || []).flatMap((e: any) => e.servers || [])),
  ];

  /** Candidatos por host: solo los que HOY se publicarían, que son los que importa poder servir. */
  const porHost = new Map<string, any[]>();
  for (const row of rows) {
    for (const s of servidoresDe(row)) {
      if (!s?.embed_url || !s.direct_stream || !s.verified_at) continue;
      if (Date.now() - Date.parse(s.verified_at) > 6 * 60 * 60 * 1000) continue;
      const h = hostDe(s.embed_url);
      if (!porHost.has(h)) porHost.set(h, []);
      const lista = porHost.get(h)!;
      if (lista.length < 4 && !lista.some(x => x.embed_url === s.embed_url)) lista.push(s);
    }
  }
  console.log(`   ${porHost.size} hosts con servidores publicados\n`);

  /**
   * Una petición idéntica a la del reproductor, Y HASTA EL FINAL.
   *
   * El primer intento se quedaba en la primera respuesta y daba por malo todo lo que no llegara a
   * 1 KB. Falso: en HLS la primera respuesta es el MANIFIESTO, y un manifiesto son cuatro líneas
   * de texto. Medido — emturbovid devolvía 583 bytes de `#EXTM3U` impecable con sus dos calidades,
   * y la regla lo condenaba junto con dropload y turbovidhls. Habría escondido 720 fichas por
   * confundir «pesa poco» con «está roto».
   *
   * Un manifiesto tampoco demuestra nada por sí solo: dice qué calidades hay, no que los trozos
   * de vídeo lleguen. Así que se sigue la cadena igual que ExoPlayer —maestro → variante →
   * SEGMENTO— y solo cuentan como entrega los BYTES DE VÍDEO del final. Es la misma prueba que
   * hace `--verificar` contra el host, solo que por el camino que usa el espectador.
   */
  async function entrega(s: any): Promise<{ ok: boolean; detalle: string }> {
    const t = Date.now();
    const pasos: string[] = [];
    let url = API + directEndpointUrl(s.embed_url, s.direct_kind === 'mp4' ? 'mp4' : 'hls');

    try {
      // Como mucho tres saltos: maestro, variante y segmento. Con eso se llega a vídeo siempre.
      for (let salto = 0; salto < 3; salto++) {
        const r = await streamClient.get(url, {
          headers: { Range: 'bytes=0-65535' },
          responseType: 'arraybuffer',
          maxRedirects: 5,
          timeout: 30000,
          validateStatus: () => true,
        });
        const buf: Buffer = Buffer.from((r.data as any) || []);
        pasos.push(`${r.status}/${buf.length}B`);

        if (r.status !== 200 && r.status !== 206) {
          return { ok: false, detalle: `${pasos.join('→')}/${((Date.now() - t) / 1000).toFixed(1)}s` };
        }

        const texto = buf.slice(0, 16).toString('utf8');
        if (!texto.startsWith('#EXTM3U')) {
          // Ya no es una lista: esto son bytes de vídeo. Con que lleguen unos pocos KB basta —
          // lo que se está midiendo es si el camino entrega, no cuánto pesa la película.
          const ok = buf.length > 2048;
          return { ok, detalle: `${pasos.join('→')}/${((Date.now() - t) / 1000).toFixed(1)}s` };
        }

        // Es una lista: se sigue por su primera entrada real (las líneas con `#` son cabeceras).
        const siguiente = buf.toString('utf8').split(/\r?\n/).map(l => l.trim())
          .find(l => l && !l.startsWith('#'));
        if (!siguiente) {
          return { ok: false, detalle: `${pasos.join('→')}/lista-vacía/${((Date.now() - t) / 1000).toFixed(1)}s` };
        }
        url = /^https?:\/\//i.test(siguiente) ? siguiente : API + (siguiente.startsWith('/') ? '' : '/') + siguiente;
      }
      return { ok: false, detalle: `${pasos.join('→')}/sin-llegar-al-vídeo/${((Date.now() - t) / 1000).toFixed(1)}s` };
    } catch (e) {
      return { ok: false, detalle: `${pasos.join('→')}/${e instanceof Error ? e.message : e}/${((Date.now() - t) / 1000).toFixed(1)}s` };
    }
  }

  const caidos: string[] = [];
  for (const [host, muestras] of porHost) {
    let vivo = false;
    const detalles: string[] = [];
    for (const s of muestras) {
      const r = await entrega(s);
      detalles.push(r.detalle);
      if (r.ok) { vivo = true; break; }
    }
    console.log(`   ${vivo ? 'OK ' : 'NO '} ${host.padEnd(32)} ${detalles.join(' | ')}`);
    if (!vivo) caidos.push(host);
  }

  if (caidos.length === 0) {
    console.log('\n✅ todos los hosts publicados se pueden entregar desde la API');
    return;
  }
  console.log(`\n❌ ${caidos.length} host(s) que la API NO puede entregar: ${caidos.join(', ')}`);

  const condenados = new Set(caidos);
  let fichasTocadas = 0, sellosRetirados = 0, seEsconden = 0;

  for (const row of rows) {
    let cambio = false;
    /** Se retira la PRUEBA, no el enlace. Ver la nota de arriba. */
    const desellar = (s: any) => {
      if (!s?.embed_url || !s.verified_at || !condenados.has(hostDe(s.embed_url))) return s;
      cambio = true; sellosRetirados++;
      const { verified_at, ...resto } = s;
      return resto;
    };
    const servers = (row.servers || []).map(desellar);
    const seasons = (row.seasons || []).map((t: any) => ({
      ...t,
      episodes: (t.episodes || []).map((e: any) => (
        Array.isArray(e?.servers) ? { ...e, servers: e.servers.map(desellar) } : e
      )),
    }));
    if (!cambio) continue;

    fichasTocadas++;
    const veredicto = veredictoDisponibilidad({ type: row.type, servers, seasons }, 'todo');
    if (veredicto === false && row.has_streams !== false) seEsconden++;
    if (!apply) continue;

    marcarTocada(row);
    const { error } = await db.from('media_items')
      .update({ servers, seasons, has_streams: veredicto ?? row.has_streams })
      .eq('id', row.id);
    if (error) console.warn(`   ⚠ ${row.id}: ${error.message}`);
  }

  console.log(`\n🚫 ${sellosRetirados} sellos retirados en ${fichasTocadas} fichas · ${seEsconden} dejan de anunciarse ${apply ? '' : '(se harían)'}`);
  console.log(apply ? '   ✅ aplicado' : '   (dry-run: repite con --apply)');
  await purgarCacheDeTocadas(apply);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FUENTE PROPIA, DE UN VISTAZO (`--manuales`)
 *
 * Tres trabajos en uno, porque las tres preguntas son la misma: **¿sigue en pie lo que pegué?**
 *
 *   1. RESPALDA lo que aún no tiene libro. Las urls pegadas antes de la migración 009 viven solo
 *      dentro de `servers`/`seasons`, o sea sin red: la primera escritura que pase por encima se
 *      las lleva. Con el libro escrito, ya no.
 *   2. RESTAURA lo que el libro tiene y la fila ha perdido. Es la misma operación que hace la API
 *      al leer una ficha, aquí sobre el catálogo entero y sin esperar a que nadie la abra.
 *   3. INFORMA de en qué estado está cada url: publicada, sin sello (existe pero todavía no se ha
 *      demostrado que reproduzca) o huérfana (el capítulo al que pertenecía ya no está en el
 *      árbol). Sin esto, «no se ve mi url» obliga a mirar la base a mano.
 *
 * En dry-run no escribe nada: dice lo que haría. Es lo que hay que correr cuando algo de la fuente
 * propia no aparezca, ANTES de volver a pegar nada.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function auditarFuentePropia(apply: boolean): Promise<void> {
  console.log(`📌 Repasando la fuente propia${apply ? '' : ' (dry-run)'}...`);

  if (!(await hasColumn('manual_servers'))) {
    console.log('   ✗ falta la migración 009 (manual_servers). Pégala en el SQL Editor de Supabase:');
    console.log('     src/db/migrations/009_manual_servers.sql');
    return;
  }

  const rows = await fetchAllRows(['servers', 'seasons', 'has_streams', 'manual_servers']);

  let conManuales = 0, respaldadas = 0, restauradas = 0, urlsRestauradas = 0, huerfanas = 0;
  let publicadas = 0, sinSello = 0, urlsDuplicadas = 0;

  for (const row of rows) {
    const enLaFila = extraerManuales(row);
    const libro = leerLedger(row.manual_servers);
    if (ledgerVacio(enLaFila) && ledgerVacio(libro)) continue;
    conManuales++;

    const titulo = String(row.title || row.id).slice(0, 44);

    // 2. ¿Falta algo de lo que el libro dice que hay? ¿O sobra alguna copia repetida?
    const { servers, seasons, recuperados, duplicados } = ledgerVacio(libro)
      ? { servers: row.servers || [], seasons: row.seasons || [], recuperados: 0, duplicados: 0 }
      : fusionarConLedger(row, libro);
    urlsDuplicadas += duplicados;

    if (recuperados > 0 || duplicados > 0) {
      restauradas++;
      urlsRestauradas += recuperados;
      const que = [
        recuperados ? `${recuperados} url(es) perdidas` : '',
        duplicados ? `${duplicados} copia(s) del mismo fichero` : '',
      ].filter(Boolean).join(' y ');
      console.log(`   ♻ ${titulo} · ${que} ${apply ? 'arregladas' : 'a arreglar'}`);
      row.servers = servers;
      row.seasons = seasons;
      if (apply) {
        marcarTocada(row);
        const update: Record<string, unknown> = { servers };
        if (Array.isArray(seasons) && seasons.length) update.seasons = seasons;
        const { error } = await db.from('media_items').update(update).eq('id', row.id);
        if (error) console.warn(`     ⚠ ${row.id}: ${error.message}`);
      }
    }

    /**
     * Y las que el libro guarda para un capítulo que ya no existe en el árbol. No se inventan:
     * meterlas crearía un capítulo fantasma. Se dicen, que es lo accionable — casi siempre
     * significa que la serie se renumeró o que el capítulo se pegó con el número equivocado.
     */
    let huerfanasAqui = 0;
    for (const c of libro.capitulos) {
      const existe = ((row.seasons || []) as any[]).some((t: any) =>
        Number(t?.season_number) === c.season &&
        ((t?.episodes || []) as any[]).some((e: any) => Number(e?.episode_number) === c.episode)
      );
      if (!existe && c.servers.length) {
        huerfanas += c.servers.length;
        huerfanasAqui += c.servers.length;
        console.log(`   ⚠ ${titulo} · ${c.servers.length} url(es) guardadas para un T${c.season}E${c.episode} que no está en el árbol`);
      }
    }

    /**
     * 1. EL LIBRO, AL DÍA.
     *
     * Dos casos: la ficha que aún no tenía ninguno (lo pegado antes de la migración 009), y el
     * libro que se escribió con copias repetidas dentro —`extraerManuales` ahora las colapsa—.
     *
     * Y NO se reescribe si esta ficha tiene urls huérfanas. El libro las guarda para un capítulo
     * que hoy no está en el árbol, así que no aparecen en la foto de la fila: rehacerlo las
     * borraría para siempre, que es justo lo contrario de para lo que existe. Antes hay que
     * arreglar el árbol o volver a pegarlas donde toque.
     */
    const alDia = extraerManuales(row);
    const teniaLibro = !ledgerVacio(libro);
    const cambia = todoElLedger(alDia).length !== todoElLedger(libro).length;
    if (!ledgerVacio(alDia) && (!teniaLibro || (cambia && !huerfanasAqui))) {
      respaldadas++;
      console.log(`   💾 ${titulo} · ${todoElLedger(alDia).length} url(es) ${apply ? (teniaLibro ? 'reescritas en el libro' : 'respaldadas') : 'a respaldar'}`);
      if (apply) {
        marcarTocada(row);
        const { error } = await db.from('media_items').update({ manual_servers: alDia }).eq('id', row.id);
        if (error) console.warn(`     ⚠ ${row.id}: ${error.message}`);
      }
    }

    // 3. En qué estado queda cada url.
    const deLaFicha = ((row.servers || []) as any[]).filter(esManual);
    const deCapitulos = ((row.seasons || []) as any[])
      .flatMap((t: any) => (t?.episodes || []))
      .flatMap((e: any) => ((e?.servers || []) as any[]).filter(esManual));
    const todas = [...deLaFicha, ...deCapitulos];
    const vivas = paraElCliente(todas).length;
    publicadas += vivas;
    sinSello += todas.length - vivas;
  }

  console.log(
    `\n📌 ${conManuales} ficha(s) con urls propias · ${publicadas} publicándose · ${sinSello} sin sello (esperando al verificador)`
  );
  if (respaldadas) console.log(`   💾 ${respaldadas} ficha(s) ${apply ? 'respaldadas' : 'a respaldar'} en el libro`);
  if (urlsRestauradas) console.log(`   ♻ ${urlsRestauradas} url(es) ${apply ? 'devueltas' : 'a devolver'} a su ficha`);
  if (urlsDuplicadas) console.log(`   ♻ ${urlsDuplicadas} copia(s) repetidas del mismo fichero ${apply ? 'retiradas' : 'a retirar'}`);
  if (huerfanas) console.log(`   ⚠ ${huerfanas} url(es) apuntan a un capítulo que ya no existe`);
  if (!conManuales) console.log('   (no hay ninguna url puesta a mano en el catálogo)');
  console.log(apply ? '   ✅ aplicado' : '   (dry-run: repite con --apply)');
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

  if (process.argv.includes('--purgar-sin-identidad')) {
    await purgarSinIdentidad(apply);
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

  if (process.argv.includes('--directos-falsos')) {
    await repairFakeDirects(
      apply,
      Number.isFinite(limitArg) ? limitArg : undefined,
      (process.argv.find(a => a.startsWith('--host=')) || '').split('=')[1]
    );
    return;
  }

  if (process.argv.includes('--huerfanas')) {
    await hideOrphanRows(apply);
    return;
  }

  if (process.argv.includes('--sin-directo')) {
    await hideRowsWithoutDirect(apply);
    return;
  }

  if (process.argv.includes('--entrega')) {
    await checkDeliveryByHost(apply);
    return;
  }

  if (process.argv.includes('--politica')) {
    await reconcilePolicyDirects(apply);
    return;
  }

  if (process.argv.includes('--episodios')) {
    await checkEpisodes(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--episodios-prestados')) {
    await purgeBorrowedEpisodeServers(apply);
    return;
  }

  if (process.argv.includes('--manuales')) {
    await auditarFuentePropia(apply);
    return;
  }

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * URLS DIRECTAS QUE NO CADUCAN (`--permanentes`)
 *
 * Es el catálogo que se pidió: cada ficha con TODAS sus urls directas funcionales, y lo que no
 * tenga ninguna no se muestra. Sin acuñar nada al reproducir, sin sellos de seis horas, sin
 * proxy — la url que se guarda es la que el reproductor pide.
 *
 * POR QUÉ ESTO ES DISTINTO DE TODO LO DEMÁS DE ESTE FICHERO. El resto del catálogo vive de urls
 * FIRMADAS: `?t=VMhp30…&s=1787139630&e=129600` de vidhideplus, `?expires=1787149324&md5=…` de
 * vidsonic. Esas no se pueden guardar — a las pocas horas devuelven 403 aunque el fichero siga
 * ahí—, y de ahí sale toda la maquinaria de acuñar, sellar y volver a sellar.
 *
 * Pero una parte del catálogo NO es así. Los envoltorios de FuegoCine llevan la dirección real
 * dentro de un parámetro (`?link=https://archive.org/download/…mp4`), y esa sí es el fichero:
 * sin firma, sin caducidad, sin atadura de IP. Medido sobre el catálogo: 960 fichas la tienen,
 * repartidas en 1a-1791 (504), rumble (204), archive.org (145), eintim (84) y pixeldrain (10).
 *
 * Lo que hace esta pasada:
 *   1. recorre cada ficha y saca TODAS las urls candidatas (del envoltorio y del propio embed);
 *   2. descarta las que lleven firma o caducidad (`hasVolatileToken`);
 *   3. comprueba una a una que devuelven BYTES DE VÍDEO, no una página de error;
 *   4. guarda las que pasan como `direct_mode: 'public'`, con la url REAL en `direct_stream`.
 *
 * El modo `public` existía en el tipo desde hace tiempo y no lo producía nadie. Es el único que
 * no pasa por esta API: el reproductor va directo al fichero. Eso, además de ser más fiable,
 * quita el vídeo del presupuesto de tránsito de Vercel.
 *
 *   npm run repair:catalog -- --permanentes            (dry-run)
 *   npm run repair:catalog -- --permanentes --apply
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const FICHERO_PERMANENTE = [
  /pixeldrain\.com\/api\/file\//i,
  /archive\.org\/download\//i,
  /1a-\d+\.com\/video\//i,
  /cdn\.rumble\.cloud\/video\//i,
  /remux\.unlimplay\.com\/remux/i,
  /\.(mp4|mkv|webm)(\?|$)/i,
];

/** La dirección que un envoltorio lleva dentro de sus parámetros, si la lleva. */
function urlDentroDelEnvoltorio(embed: string): string | null {
  try {
    const q = new URL(embed).searchParams;
    for (const [, v] of q) {
      if (!v) continue;
      if (/^https?:\/\//i.test(v)) return v;
      if (/^[\w.-]+\.[a-z]{2,}\//i.test(v)) return `https://${v}`;
    }
  } catch { /* no es una url con parámetros */ }
  return null;
}

/** ¿Devuelve bytes de vídeo? Se piden 64 KB: basta para ver la cabecera del contenedor. */
async function entregaVideoPermanente(url: string): Promise<boolean> {
  try {
    const r = await streamClient.get(url, {
      headers: { Range: 'bytes=0-65535' },
      responseType: 'arraybuffer',
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    if (r.status >= 400) return false;
    if (/text\/html/i.test(String(r.headers['content-type'] || ''))) return false;
    return ((r.data as ArrayBuffer)?.byteLength ?? 0) > 8192;
  } catch {
    return false;
  }
}

async function recogerPermanentes(apply: boolean, limitArg?: number): Promise<void> {
  console.log(`🔗 Buscando urls directas que no caduquen${apply ? '' : ' (dry-run: no se escribe nada)'}...`);
  const rows = await fetchAllRows(['servers', 'has_streams', 'title']);

  const candidatas = rows
    .map((r: any) => {
      const servidores = Array.isArray(r.servers) ? r.servers : [];
      const urls = new Map<number, string>();   // índice del servidor → url permanente candidata
      servidores.forEach((sv: any, i: number) => {
        if (sv?.status === 'offline') return;
        const embed = String(sv?.embed_url || '');
        for (const cand of [urlDentroDelEnvoltorio(embed), embed]) {
          if (!cand) continue;
          if (!FICHERO_PERMANENTE.some(re => re.test(cand))) continue;
          if (hasVolatileToken(cand)) continue;
          urls.set(i, cand);
          break;
        }
      });
      return { fila: r, urls };
    })
    .filter(c => c.urls.size > 0);

  const objetivo = Number.isFinite(limitArg) && (limitArg as number) > 0
    ? candidatas.slice(0, limitArg as number)
    : candidatas;
  console.log(`   ${candidatas.length} fichas con alguna url candidata · se comprueban ${objetivo.length}
`);

  let conAlguna = 0, urlsBuenas = 0, urlsMalas = 0, fichasEscritas = 0;
  const CONC = 6;

  for (let i = 0; i < objetivo.length; i += CONC) {
    await Promise.all(objetivo.slice(i, i + CONC).map(async ({ fila, urls }) => {
      const servidores = [...(fila.servers as any[])];
      let buenas = 0;

      await Promise.all(Array.from(urls.entries()).map(async ([idx, url]) => {
        if (await entregaVideoPermanente(url)) {
          buenas++;
          urlsBuenas++;
          servidores[idx] = {
            ...servidores[idx],
            direct_stream: url,          // la url REAL, no el endpoint de esta API
            direct_mode: 'public',
            direct_kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4',
            status: 'online',
            verified_at: new Date().toISOString(),
          };
        } else {
          urlsMalas++;
        }
      }));

      if (buenas === 0) return;
      conAlguna++;
      if (!apply) return;
      const { error } = await db.from('media_items')
        .update({ servers: servidores, has_streams: true, streams_checked_at: new Date().toISOString() })
        .eq('id', fila.id).select('id');
      if (!error) {
        fichasEscritas++;
        tocadas.push({ id: fila.id, tmdb_id: fila.tmdb_id });
      }
    }));
    if ((i + CONC) % 120 < CONC) {
      console.log(`   ${Math.min(i + CONC, objetivo.length)}/${objetivo.length} · ${conAlguna} fichas con url permanente`);
    }
  }

  console.log(`
🔗 ${urlsBuenas} urls entregan vídeo · ${urlsMalas} no · ${conAlguna} fichas tendrían al menos una`);
  console.log(apply ? `   ✅ escritas ${fichasEscritas} fichas` : '   (dry-run: repite con --apply para escribirlas)');
  await purgarCacheDeTocadas(apply);
}

  if (process.argv.includes('--permanentes')) {
    await recogerPermanentes(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--verificar')) {
    await verifyPlayableServers(
      apply,
      Number.isFinite(limitArg) ? limitArg : undefined,
      (process.argv.find(a => a.startsWith('--host=')) || '').split('=')[1]
    );
    return;
  }

  if (process.argv.includes('--series-ocultas')) {
    await recoverHiddenSeries(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--modos')) {
    await repairStaleModes(apply, Number.isFinite(limitArg) ? limitArg : undefined);
    return;
  }

  if (process.argv.includes('--sinopsis')) {
    await repairFillerOverviews(apply, Number.isFinite(limitArg) ? limitArg : undefined);
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
          ? 'id,type,title,original_title,release_date,aliases,source_url,source_urls'
          : 'id,type,title,original_title,release_date,aliases,source_url')
        .eq('tmdb_id', match.id)
        .neq('id', row.id);

      if (clash && clash.length > 0) {
        // La gemela que cuenta es la del MISMO catálogo, por el mismo motivo que en `--verify`:
        // con el UNIQUE en (tmdb_id, type), una película y una serie comparten número sin tener
        // nada que ver, y coger la primera que salga puede llevar a borrar una fila comparándola
        // con una obra ajena. Ver el comentario largo de la otra consulta de choques.
        const tipoFila: ContentType = row.type === 'tvseries' ? 'tvseries' : 'movie';
        const twin: any = clash.find((c: any) => (c.type === 'tvseries' ? 'tvseries' : 'movie') === tipoFila) || clash[0];
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
