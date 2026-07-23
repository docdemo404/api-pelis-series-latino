/**
 * Reparación de fichas mal emparejadas contra TMDB.
 *
 *   npm run repair:catalog                        # solo informa (dry-run), no escribe nada
 *   npm run repair:catalog -- --list              # lista las fichas sospechosas y sale
 *   npm run repair:catalog -- --apply             # aplica las correcciones en Supabase
 *   npm run repair:catalog -- --apply --dedupe    # además elimina duplicados rotos
 *   npm run repair:catalog -- --fuse              # informa de duplicados ENTRE FUENTES
 *   npm run repair:catalog -- --fuse --apply      # los funde bajo su ficha oficial de TMDB
 *   npm run repair:catalog -- --posters           # informa de poster/backdrop cruzados
 *   npm run repair:catalog -- --posters --apply   # los corrige con las imágenes de TMDB
 *   npm run repair:catalog -- --reindex --apply   # reconstruye title_normalized
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
import { TmdbService } from '../src/services/tmdbService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { canonicalTitle, normalizeTitle, searchIndexKey } from '../src/utils/text';
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
 * Título y año originales según el id de la fuente.
 * FuegoCine antepone `YYYY-MM-` y añade `-YYYY-html`; TioPlus usa el slug pelado.
 */
function sourceTitleFromId(id: string): { title: string; year?: string } {
  let slug = String(id || '').trim().toLowerCase();
  if (!slug) return { title: '' };

  slug = slug.replace(/^fc-/, '').replace(/-html$/, '').replace(/^\d{4}-\d{2}-/, '');

  let year: string | undefined;
  const yearMatch = slug.match(/-(\d{4})$/);
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    if (y >= 1900 && y <= 2100) {
      year = yearMatch[1];
      slug = slug.slice(0, -5);
    }
  }

  return { title: slug.replace(/-/g, ' ').trim(), year };
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

async function fetchAllRows(): Promise<any[]> {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('media_items')
      .select('id,tmdb_id,type,title,original_title,aliases,release_date')
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

    for (const { row, match } of results) {
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
  const limitArg = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '', 10);

  if (process.argv.includes('--reindex')) {
    await reindexSearchKeys(apply);
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
        const match = await TmdbService.resolveTmdb(sourceTitle, type, year, row.id);
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
        .select('id,title,original_title,release_date')
        .eq('tmdb_id', match.id)
        .neq('id', row.id)
        .limit(1);

      if (clash && clash.length > 0) {
        const twin = clash[0];
        // Solo se borra si la gemela es INEQUÍVOCAMENTE el mismo título: parecido muy alto
        // y sin números de secuela discordantes ("cambio de bebés" vs "cambio de bebés 2"
        // son películas distintas, no un duplicado).
        const twinIsCorrect = isSameTitleStrict(sourceTitle, twin, year);

        if (dedupe && twinIsCorrect) {
          if (apply) {
            const { error } = await db.from('media_items').delete().eq('id', row.id);
            if (error) {
              console.warn(`     ⚠ no se pudo borrar ${row.id}: ${error.message}`);
              collisions++;
              continue;
            }
          }
          deleted++;
          console.log(`   ␡ ${row.id}\n     duplicado roto "${row.title}" eliminado; se conserva ${twin.id} = "${twin.title}"`);
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
