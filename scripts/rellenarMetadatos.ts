/**
 * Relleno de HUECOS de metadata, en cascada y campo por campo.
 *
 *   npm run metadatos:rellenar                      # solo informa (dry-run), no escribe nada
 *   npm run metadatos:rellenar -- --apply           # …y lo escribe en Supabase
 *   npm run metadatos:rellenar -- --limit=50        # una tanda corta (para probar)
 *   npm run metadatos:rellenar -- --ids=a,b,c       # solo esas fichas
 *   npm run metadatos:rellenar -- --solo=logo,overview
 *                                                   # solo esos campos
 *   npm run metadatos:rellenar -- --sin-wiki        # sin el paso de Wikidata/Wikipedia
 *   npm run metadatos:rellenar -- --sin-tmdb        # sin releer TMDB (útil tras una pasada)
 *   npm run metadatos:rellenar -- --detalle         # imprime ficha por ficha lo que se rellena
 *
 * QUÉ PROBLEMA RESUELVE, con los números que lo motivaron (609 fichas, agosto de 2026):
 *
 *     logo             143 vacías (23,5 %)      runtime          108 (17,7 %)
 *     trailer          133 (21,8 %)             director          52 (8,5 %)
 *     content_rating   122 (20,0 %)             backdrop          51 (8,4 %)
 *     sinopsis en inglés                         27 (4,4 %)
 *
 * Y la pregunta que había que contestar antes de elegir fuente: ¿el hueco es nuestro o de TMDB?
 * `scripts/dev/diag_hueco_tmdb.ts` le vuelve a preguntar a TMDB SIN filtros por cada ficha
 * incompleta, y sale que el 92 % son huecos de TMDB de verdad. El catálogo está lleno de cine
 * argentino y venezolano viejo con ficha creada y vacía; reintentar TMDB mil veces no la llena.
 *
 * De ahí los tres pasos, en este orden y por una razón cada uno:
 *
 *   1. TMDB otra vez. Recupera el 8 % que sí era nuestro: filas rancias pobladas antes de que
 *      existiera `pickContentRating` (Shrek Tercero no tiene clasificación guardada y TMDB la
 *      publica para 27 países) y logos que el filtro `include_image_language` descartaba.
 *   2. Wikidata + Wikipedia en español. Sinopsis, duración, director e imdb_id, ya en español.
 *   3. Fanart.tv para los logos, si hay FANART_API_KEY en el entorno.
 *
 * DOS REGLAS QUE NO SE ROMPEN:
 *
 *   · No se pisa NUNCA un campo que ya tenga valor. Esto rellena huecos; corregir datos
 *     equivocados es trabajo de `repair:catalog`, que sabe comprobar contra la fuente. La única
 *     excepción es la sinopsis en inglés, que se trata como hueco porque para esta API lo es.
 *   · Se anota de dónde salió cada campo prestado en `metadata_fuentes` (migración 012). Sin eso
 *     no hay vuelta atrás el día que TMDB publique lo que hoy no tiene.
 */
import 'dotenv/config';
import { TmdbService, TMDB_API_KEY } from '../src/services/tmdbService';
import { completarHuecos, fallosDeRed } from '../src/services/complementoService';
import { CatalogService } from '../src/services/catalogService';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { CacheStore } from '../src/cache/store';
import { pareceIngles } from '../src/utils/text';
import { ContentType } from '../src/types';

const db = getSupabaseAdmin();

const args = process.argv.slice(2);
const tiene = (f: string) => args.includes(f);
const valor = (f: string) => (args.find(a => a.startsWith(`${f}=`)) || '').split('=')[1] || '';

const APLICAR = tiene('--apply');
const DETALLE = tiene('--detalle');
const CON_TMDB = !tiene('--sin-tmdb');
const CON_WIKI = !tiene('--sin-wiki');
const CON_FANART = !tiene('--sin-fanart');
const LIMITE = Number(valor('--limit') || 0);
const IDS = valor('--ids').split(',').map(s => s.trim()).filter(Boolean);
const SOLO = valor('--solo').split(',').map(s => s.trim()).filter(Boolean);

/**
 * Los campos que este barrido sabe rellenar, y de qué columna hablan.
 *
 * `poster` NO está, y no es un olvido: solo le faltaba a 5 fichas y es el campo donde una imagen
 * equivocada se ve en cada carrusel. Lo cubre `repair:catalog --posters`, que compara contra la
 * página de origen en vez de aceptar lo primero que haya.
 */
const CAMPOS = [
  'logo', 'backdrop', 'trailer', 'runtime', 'content_rating',
  'director', 'genres', 'cast_data', 'overview', 'imdb_id',
] as const;
type Campo = typeof CAMPOS[number];

const pedidos: Campo[] = SOLO.length > 0
  ? CAMPOS.filter(c => SOLO.includes(c))
  : [...CAMPOS];

/** Vacío de verdad: null, cadena en blanco o lista sin elementos. */
function vacio(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return v === 0;
  return false;
}

/**
 * ¿Le falta este campo a la ficha?
 *
 * La sinopsis tiene regla propia. La cascada de `getTmdbDetails` acaba en inglés a propósito —una
 * sinopsis real informa más que ninguna—, pero en una API que sirve en español eso es un hueco
 * tapado con un trapo, no un campo relleno. Comprobado contra TMDB: de las 27 fichas así, NINGUNA
 * tiene traducción al español que rescatar, o sea que el trapo se queda hasta que lo cambie otra
 * fuente. Ver `pareceIngles`.
 */
function leFalta(fila: any, campo: Campo): boolean {
  if (campo === 'overview') return vacio(fila.overview) || pareceIngles(fila.overview);
  return vacio(fila[campo]);
}

const COLUMNAS_BASE = 'id,tmdb_id,type,title,original_title,overview,logo,poster,backdrop,trailer,runtime,content_rating,director,genres,cast_data,imdb_id';

/**
 * Todas las fichas, paginadas por clave (ver el porqué en repairCatalog).
 *
 * `metadata_fuentes` solo se pide si la migración 012 está puesta: pedir una columna que no existe
 * no devuelve nulos, aborta la consulta entera con «column does not exist», y entonces el barrido
 * no correría en una base sin migrar ni siquiera para informar.
 */
async function leerFichas(conFuentes: boolean): Promise<any[]> {
  const columnas = conFuentes ? `${COLUMNAS_BASE},metadata_fuentes` : COLUMNAS_BASE;
  if (IDS.length > 0) {
    const { data, error } = await db.from('media_items').select(columnas).in('id', IDS);
    if (error) throw new Error(error.message);
    return data || [];
  }
  const filas: any[] = [];
  let ultimo = '';
  for (;;) {
    let q = db.from('media_items').select(columnas).order('id', { ascending: true }).limit(1000);
    if (ultimo) q = q.gt('id', ultimo);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    filas.push(...data);
    ultimo = (data[data.length - 1] as any).id;
    if (data.length < 1000) break;
  }
  return filas;
}

/** Comprueba que la migración 012 esté puesta antes de intentar escribir en su columna. */
async function hayColumnaDeFuentes(): Promise<boolean> {
  const { error } = await db.from('media_items').select('metadata_fuentes').limit(1);
  return !error;
}

interface Relleno {
  valor: any;
  /** De dónde salió, tal y como se guardará en `metadata_fuentes`. */
  fuente: string;
}

const tocadas: Array<{ id: string; tmdb_id: number }> = [];
const marcador: Record<string, number> = {};
function anotar(clave: string): void { marcador[clave] = (marcador[clave] || 0) + 1; }

async function rellenar(fila: any): Promise<Record<Campo, Relleno> | null> {
  const tipo: ContentType = fila.type === 'tvseries' ? 'tvseries' : 'movie';
  const huecos = pedidos.filter(c => leFalta(fila, c));
  if (huecos.length === 0) return null;

  const encontrado = {} as Record<Campo, Relleno>;
  const sigueFaltando = () => huecos.filter(c => !(c in encontrado));

  // ── Paso 1: TMDB otra vez ───────────────────────────────────────────────────────────────────
  // Es el más barato (una petición que ya viene cacheada por id) y el único que devuelve el dato
  // PROPIO de la ficha, así que va primero y lo que aporte no se anota como prestado.
  if (CON_TMDB && fila.tmdb_id > 0) {
    const detalle = await TmdbService.getTmdbDetails(fila.tmdb_id, tipo).catch(() => null);
    if (detalle) {
      const campos = TmdbService.camposDeTmdb(detalle);
      for (const campo of sigueFaltando()) {
        const v = campos[campo];
        // La sinopsis es el caso especial: si TMDB solo tiene la inglesa que ya está guardada,
        // esto no es un relleno, es escribir lo mismo otra vez. Que siga contando como hueco.
        if (campo === 'overview' && (vacio(v) || pareceIngles(v))) continue;
        if (!vacio(v)) { encontrado[campo] = { valor: v, fuente: 'tmdb' }; anotar('tmdb'); }
      }
    }
  }

  // ── Pasos 2 y 3: lo que TMDB no tiene ─────────────────────────────────────────
  // La cascada NO se implementa aquí: es la misma `completarHuecos` que corre en la puerta de
  // entrada del catálogo (`enrichMediaItem` con `complementar`). Con una copia en cada sitio, un
  // título recién rastreado y uno repasado por este barrido acabarían con criterios distintos.
  if (CON_WIKI || CON_FANART) {
    const pendientes = sigueFaltando();
    // Se le pasa una ficha con los huecos que QUEDAN: los que TMDB acaba de tapar en el paso 1 ya
    // no son huecos, y preguntar por ellos sería gastar una consulta para tirar la respuesta.
    const conLoDeTmdb: any = { ...fila, tmdb_id: fila.tmdb_id, type: tipo };
    for (const [campo, r] of Object.entries(encontrado)) conLoDeTmdb[campo] = r.valor;
    const tapado = await completarHuecos(conLoDeTmdb, {
      tmdbApiKey: TMDB_API_KEY, conFanart: CON_FANART, conWikidata: CON_WIKI,
    });
    for (const [campo, valor] of Object.entries(tapado.campos)) {
      if (!pedidos.includes(campo as Campo) || !pendientes.includes(campo as Campo)) continue;
      const fuente = tapado.fuentes[campo];
      encontrado[campo as Campo] = { valor, fuente };
      anotar(fuente.startsWith('wikipedia') ? 'wikipedia' : fuente.split(':')[0]);
    }
  }

  return Object.keys(encontrado).length > 0 ? encontrado : null;
}

async function escribir(fila: any, relleno: Record<Campo, Relleno>, conFuentes: boolean): Promise<boolean> {
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  const fuentes: Record<string, string> = { ...(fila.metadata_fuentes || {}) };

  for (const [campo, r] of Object.entries(relleno)) {
    patch[campo] = r.valor;
    // Lo que viene de TMDB es el caso normal y no se anota: `metadata_fuentes` lista lo PRESTADO.
    // Y si el campo estaba anotado de una pasada anterior y ahora lo aporta TMDB, la anotación
    // sobra — el dato ya es propio.
    if (r.fuente === 'tmdb') delete fuentes[campo];
    else fuentes[campo] = r.fuente;
  }
  if (conFuentes) patch.metadata_fuentes = fuentes;

  const { error } = await db.from('media_items').update(patch).eq('id', fila.id);
  if (error) {
    console.warn(`   ⚠ ${fila.title}: ${error.message}`);
    return false;
  }
  tocadas.push({ id: String(fila.id), tmdb_id: fila.tmdb_id });
  return true;
}

/**
 * Retira del caché lo tocado. Sin esto el arreglo tarda horas en verse y parece no haber
 * funcionado: la metadata se cachea 6 h y los listados llevan la ficha COPIADA dentro.
 */
async function purgarCache(): Promise<void> {
  if (!APLICAR || tocadas.length === 0) return;
  const vistas = new Set<string>();
  const unicas = tocadas.filter(t => (vistas.has(t.id) ? false : (vistas.add(t.id), true)));
  const claves = unicas.flatMap(t => CatalogService.cacheKeysFor(t));
  const TANDA = 400;
  for (let i = 0; i < claves.length; i += TANDA) await CacheStore.del(...claves.slice(i, i + TANDA));
  await CatalogService.invalidateListings().catch(() => {});
  console.log(`\n🧹 ${unicas.length} ficha(s) retiradas del caché` +
    (CacheStore.isShared() ? ' (Redis compartido)' : ' (solo memoria local: en producción caducan por TTL)'));
}

(async () => {
  console.log(`🧩 Relleno de metadata — ${APLICAR ? 'APLICANDO' : 'dry-run (no escribe nada)'}`);
  console.log(`   pasos: ${[CON_TMDB && 'tmdb', CON_WIKI && 'wikidata/wikipedia', CON_FANART && 'fanart'].filter(Boolean).join(' → ')}`);
  console.log(`   campos: ${pedidos.join(', ')}`);
  if (CON_FANART && !process.env.FANART_API_KEY) {
    console.log('   ⚠ sin FANART_API_KEY en el entorno: el paso de logos de Fanart.tv se salta.');
  }

  const conFuentes = await hayColumnaDeFuentes();
  if (!conFuentes) {
    console.log('   ⚠ falta la columna metadata_fuentes: ejecuta src/db/migrations/012_metadata_fuentes.sql');
    console.log('     en el SQL Editor de Supabase. Sin ella se rellena igual, pero sin dejar rastro del origen.');
  }

  const filas = await leerFichas(conFuentes);
  const conHuecos = filas.filter(f => pedidos.some(c => leFalta(f, c)));
  console.log(`\n📚 ${filas.length} fichas · ${conHuecos.length} con algún hueco`);

  const tanda = LIMITE > 0 ? conHuecos.slice(0, LIMITE) : conHuecos;
  if (LIMITE > 0) console.log(`   (limitado a ${tanda.length})`);

  // Los dos recuentos que hacen falta, y no son el mismo: lo que falta EN ESTA TANDA, que es
  // contra lo que se mide el relleno, y lo que falta en todo el catalogo, que es lo que dice
  // cuanto queda por hacer. Mezclarlos hacia que una tanda de 15 pareciera no arreglar nada.
  const antes: Record<string, number> = {};
  const enElCatalogo: Record<string, number> = {};
  for (const c of pedidos) {
    antes[c] = tanda.filter(f => leFalta(f, c)).length;
    enElCatalogo[c] = filas.filter(f => leFalta(f, c)).length;
  }

  const rellenados: Record<string, number> = {};
  let fichasTocadas = 0, escritas = 0;

  for (let i = 0; i < tanda.length; i++) {
    const fila = tanda[i];
    // Con `--detalle` no hay barra de avance: las dos escriben en la misma línea y lo que sale es
    // un renglón ilegible con los dos mensajes pisándose.
    if (!DETALLE) process.stderr.write(`\r   ${i + 1}/${tanda.length}  ${String(fila.title).slice(0, 40).padEnd(40)}`);

    const relleno = await rellenar(fila).catch(() => null);
    if (!relleno) continue;

    fichasTocadas++;
    for (const c of Object.keys(relleno)) rellenados[c] = (rellenados[c] || 0) + 1;

    if (DETALLE) {
      const resumen = Object.entries(relleno)
        .map(([c, r]) => `${c}=${r.fuente.split(':')[0]}`).join(' ');
      console.log(`   · ${String(fila.title).slice(0, 44).padEnd(44)} ${resumen}`);
    }

    if (APLICAR && await escribir(fila, relleno, conFuentes)) escritas++;
  }
  process.stderr.write('\r' + ' '.repeat(60) + '\r');

  console.log(`\n📊 RESULTADO (${tanda.length} fichas revisadas)`);
  console.log(`   ${'campo'.padEnd(16)} ${'faltaba'.padStart(8)} ${'rellenado'.padStart(10)} ${'sigue vacío'.padStart(12)} ${'catálogo'.padStart(10)}`);
  for (const c of pedidos) {
    const r = rellenados[c] || 0;
    console.log(`   ${c.padEnd(16)} ${String(antes[c]).padStart(8)} ${String(r).padStart(10)} ${String(antes[c] - r).padStart(12)} ${String(enElCatalogo[c]).padStart(10)}`);
  }

  // «Sigue vacío» solo significa «no existe en ninguna fuente» si NADA falló. Con consultas caídas
  // de por medio, parte de ese hueco es falta de respuesta, y hay que decirlo o el informe miente.
  if (fallosDeRed.total > 0) {
    console.log(`\n   ⚠ ${fallosDeRed.total} consulta(s) se rindieron tras reintentar: de esas fichas NO se sabe`);
    console.log(`     si el dato existe. Vuelve a lanzar el barrido para reintentarlas.`);
  }

  console.log(`\n   de dónde salió:`);
  for (const [k, v] of Object.entries(marcador).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${k.padEnd(24)} ${v}`);
  }

  console.log(`\n   ${fichasTocadas} ficha(s) con algo que rellenar` +
    (APLICAR ? `, ${escritas} escritas` : ' — dry-run: no se ha escrito nada. Repite con --apply.'));

  await purgarCache();
  process.exit(0);
})();
