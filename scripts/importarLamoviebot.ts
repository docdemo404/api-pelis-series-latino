/**
 * IMPORTA EL CATÁLOGO DE LAMOVIE (vía lamoviebot), Y LO MANTIENE AL DÍA.
 *
 * Mismo diseño que `importarVideoapi.ts` —una sola corrida sirve para la carga inicial y para la
 * sincronización, porque «lo nuevo» es por definición lo que está en su índice y no en el
 * nuestro— pero con DOS diferencias que no son de detalle:
 *
 * ── 1. SU `tmdb_id` SE VERIFICA, NO SE ADOPTA ────────────────────────────────────────────────
 *
 * videoapi direcciona POR tmdb_id: su id es un dato publicado y no hay identidad que demostrar.
 * Este Worker SCRAPEA lamovie.org y le pega después un id que dedujo su propio matcher, así que
 * puede cometer —y comete, en el 3 % medido— el fallo del homónimo que FUENTES.md §1 documenta
 * como origen de casi todos los destrozos del catálogo.
 *
 * Por eso cada ficha pasa por `juzgarIdentidad` antes de escribirse: se le pregunta a TMDB por el
 * id que propone y se comprueba que el título ORIGINAL (o, en su defecto, el año) lo respalde. Lo
 * que se contradice NO se escribe con un id ajeno — se cuenta aparte y se deja fuera. Perder una
 * ficha de cada treinta es barato; soldar dos obras distintas por un `tmdb_id` equivocado no se
 * deshace, porque ese número es lo que después funde dos filas en una (FUENTES.md §3).
 *
 * ── 2. EL ÍNDICE SE GUARDA EN DISCO ANTES DE TRABAJARLO ──────────────────────────────────────
 *
 * La fuente es un Worker ajeno y puede desaparecer. El volcado (`data/lamoviebot_indice.json`)
 * existe para que eso no cueste el trabajo a medias: si el Worker cae con la importación empezada,
 * la corrida siguiente termina contra el volcado sin volver a pedirle nada.
 *
 * Y conviene tener claro qué NO nos ata a él: los enlaces que se guardan son de terceros
 * (`goodstream.one`, `hlswish.com`, `voe.sx`…), no suyos. Una vez escritos, el Worker sobra para
 * reproducir — la resolución la hace `extractDirect` al darle a Reproducir, como con todas las
 * demás. Su `/streamurl` ni se usa: devuelve urls atadas a la IP del Worker, que al cliente le
 * darían 403.
 *
 * CADA FICHA SE ESCRIBE CON SU ENLACE DEMOSTRADO, igual que en videoapi: se resuelve, se baja el
 * manifiesto y se descarga un segmento real. Lo que no reproduce no se escribe.
 *
 *   npm run importar:lamoviebot -- --dry               ← qué haría, sin escribir
 *   npm run importar:lamoviebot                        ← una tanda (200 fichas, 20 min)
 *   npm run importar:lamoviebot -- --solo=animes       ← donde más aporta (16 % nuevo)
 *   npm run importar:lamoviebot -- --slug=kenan-y-kel-1996
 *   npm run importar:lamoviebot -- --limite=0 --minutos=0   ← todo, de una sentada
 *   npm run importar:lamoviebot -- --refrescar-indice  ← ignora el volcado y vuelve a pedirlo
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { httpClient } from '../src/utils/httpClient';
import { extractDirect } from '../src/scrapers/directStream';
import { bajarManifiesto, segmentoDescargable } from '../src/services/manifestHealth';
import { TmdbService, TMDB_API_KEY } from '../src/services/tmdbService';
import { fusionarTemporadas } from '../src/services/catalogService';
import { searchIndexKey } from '../src/utils/text';
import {
  listarPagina,
  detalle,
  detalleEpisodio,
  urlDeFicha,
  embedsDe,
  juzgarIdentidad,
  respalda,
  idDeFicha,
  ClaseLamoviebot,
  FichaLamoviebot,
  EmbedLamoviebot,
  UA_NAVEGADOR,
  REFERER_LAMOVIE,
} from '../src/scrapers/lamoviebot';
import { datosDeLaUrl } from '../src/scrapers/videoapi';
import { MediaItem, ServerOption, ContentType } from '../src/types';

const db = getSupabaseAdmin();
const argv = process.argv.slice(2);

/** Cero significa SIN TOPE, y hace falta poder pedirlo: los topes son para que quepa en un runner. */
const bandera = (nombre: string, pordefecto: number): number => {
  const v = argv.find((a) => a.startsWith(`--${nombre}=`));
  if (!v) return pordefecto;
  const n = Number(v.split('=')[1]);
  return Number.isFinite(n) && n >= 0 ? n : pordefecto;
};
const SIN_TOPE = Number.POSITIVE_INFINITY;
const DRY = argv.includes('--dry');
const REHACER = argv.includes('--rehacer');
const REFRESCAR = argv.includes('--refrescar-indice');
const LIMITE = bandera('limite', 200) || SIN_TOPE;
const MINUTOS = bandera('minutos', 20) || SIN_TOPE;
const CAPITULOS_POR_SERIE = bandera('capitulos', 12) || SIN_TOPE;
const A_LA_VEZ = 4;
const SOLO = (argv.find((a) => a.startsWith('--solo=')) || '').split('=')[1] || '';
const SLUGS = ((argv.find((a) => a.startsWith('--slug=')) || '').split('=')[1] || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const fin = Date.now() + (MINUTOS === SIN_TOPE ? 0 : MINUTOS * 60_000);
const quedaTiempo = () => MINUTOS === SIN_TOPE || Date.now() < fin;

const VOLCADO = path.join(process.cwd(), 'data', 'lamoviebot_indice.json');

const cuenta = {
  fichasNuevas: 0,
  fichasEnriquecidas: 0,
  capitulos: 0,
  sinVideo: 0,
  sinTmdb: 0,
  identidadRota: 0,
  errores: 0,
};

/** Las clases que se trabajan, y el tipo de nuestro catálogo al que corresponde cada una. */
const CLASES: Array<{ clase: ClaseLamoviebot; type: ContentType }> = [
  { clase: 'peliculas', type: 'movie' },
  { clase: 'series', type: 'tvseries' },
  { clase: 'animes', type: 'tvseries' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// EL ÍNDICE
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Indice {
  creado: string;
  porClase: Record<string, FichaLamoviebot[]>;
  completo?: boolean;
  enCurso?: { clase: ClaseLamoviebot; pagina: number; totalPaginas: number; totalFichas: number; fichas: FichaLamoviebot[] };
}

/**
 * El índice entero, del volcado si sirve y de la fuente si no.
 *
 * Se guarda ANTES de trabajar nada. Si el Worker muere con la importación a medias, la corrida
 * siguiente arranca de aquí: el trabajo hecho no se pierde y el pendiente no depende de que el
 * tercero siga vivo. Es la única defensa real contra que la fuente desaparezca, y cuesta un
 * fichero.
 */
async function obtenerIndice(): Promise<Indice> {
  /** Lo que ya hay guardado y sigue sirviendo, para no volver a pedir una clase entera por gusto. */
  let previo: Record<string, FichaLamoviebot[]> = {};
  let previoFresco = false;
  let checkpoint: Indice['enCurso'];

  if (!REFRESCAR && fs.existsSync(VOLCADO)) {
    try {
      const guardado: Indice = JSON.parse(fs.readFileSync(VOLCADO, 'utf8'));
      const horas = (Date.now() - new Date(guardado.creado).getTime()) / 3_600_000;
      previoFresco = horas < 24 && (guardado.completo === true || !!guardado.enCurso);
      previo = previoFresco ? (guardado.porClase || {}) : {};
      checkpoint = previoFresco ? guardado.enCurso : undefined;
      /**
       * Fresco NO BASTA: tiene que traer TODAS las clases que esta corrida va a trabajar.
       *
       * Un volcado escrito por `--solo=animes` es reciente y no tiene películas. Aceptarlo por la
       * fecha dejaba `porClase.peliculas` vacío, y como una clase sin fichas se salta sin ruido, la
       * corrida terminaba diciendo «0 pendientes» con 7.381 películas sin mirar. Un índice
       * incompleto miente mejor que uno viejo, porque el viejo al menos se nota.
       */
      const faltan = CLASES.filter(({ clase }) => !SOLO || SOLO === clase)
        .map(({ clase }) => clase)
        .filter((clase) => !(guardado.porClase || {})[clase]?.length);
      if (previoFresco && guardado.completo && guardado.porClase && !faltan.length) {
        const total = Object.values(guardado.porClase).reduce((a, b) => a + b.length, 0);
        console.log(`Índice del volcado (${Math.round(horas)} h, ${total} fichas). --refrescar-indice para rehacerlo.`);
        return guardado;
      }
      if (faltan.length && previoFresco) {
        console.log(`Volcado incompleto (falta: ${faltan.join(', ')}). Se pide lo que falta.`);
      }
    } catch {
      // Un volcado ilegible no es un fallo: se vuelve a pedir. Lo que no se hace es abortar.
    }
  }

  if (!previoFresco) previo = {};
  const porClase: Record<string, FichaLamoviebot[]> = {};
  const guardarVolcado = (enCurso?: Indice['enCurso']): void => {
    const indice: Indice = {
      creado: new Date().toISOString(), porClase: { ...previo, ...porClase },
      completo: !enCurso, ...(enCurso ? { enCurso } : {}),
    };
    fs.mkdirSync(path.dirname(VOLCADO), { recursive: true });
    fs.writeFileSync(VOLCADO, JSON.stringify(indice), 'utf8');
  };
  for (const { clase } of CLASES) {
    if (SOLO && SOLO !== clase) continue;
    // La clase que ya está guardada y fresca no se vuelve a pedir: son 308 páginas en el caso de
    // las películas, y pedirlas para acabar escribiendo lo mismo es regalarle una tanda de 300
    // peticiones a una fuente que además está detrás de Cloudflare.
    if (previoFresco && previo[clase]?.length) {
      console.log(`  ${clase}: ${previo[clase].length} fichas del volcado (frescas)`);
      continue;
    }
    const primera = await listarPagina(clase, 1);
    const reanudar = checkpoint?.clase === clase
      && checkpoint.totalPaginas === primera.totalPaginas
      && Math.abs(checkpoint.totalFichas - primera.totalFichas) <= 10;
    const fichas: FichaLamoviebot[] = reanudar ? [...checkpoint!.fichas] : [...primera.fichas];
    const desde = reanudar ? checkpoint!.pagina + 1 : 2;
    process.stdout.write(`  ${clase}: ${primera.totalFichas} fichas en ${primera.totalPaginas} páginas `);
    if (reanudar) process.stdout.write(`(reanuda en ${desde}) `);
    for (let p = desde; p <= primera.totalPaginas; p++) {
      let pagina: Awaited<ReturnType<typeof listarPagina>> | null = null;
      for (let intento = 0; intento < 3; intento++) {
        try {
          pagina = await listarPagina(clase, p);
          if (pagina.pagina !== p || !pagina.fichas.length) throw new Error(`página ${p} vacía o repetida`);
          break;
        } catch (e) {
          if (intento === 2) {
            guardarVolcado({ clase, pagina: p - 1, totalPaginas: primera.totalPaginas, totalFichas: primera.totalFichas, fichas });
            throw new Error(`Índice ${clase} incompleto en página ${p}: ${String(e)}`);
          }
          await new Promise(ok => setTimeout(ok, 1000 * (intento + 1)));
        }
      }
      fichas.push(...pagina!.fichas);
      if (p % 25 === 0) {
        guardarVolcado({ clase, pagina: p, totalPaginas: primera.totalPaginas, totalFichas: primera.totalFichas, fichas });
        process.stdout.write('.');
      }
    }
    if (primera.totalFichas && fichas.length < primera.totalFichas) {
      // El total publicado cuenta entradas, incluso cuando varias comparten el mismo slug.
      // Solo falta contenido si se han recibido menos entradas que las anunciadas.
      guardarVolcado({ clase, pagina: 1, totalPaginas: primera.totalPaginas, totalFichas: primera.totalFichas, fichas: primera.fichas });
      throw new Error(`Índice ${clase} incompleto: ${fichas.length}/${primera.totalFichas} fichas`);
    }
    const slugs = new Set<string>();
    const unicas = fichas.filter(f => !slugs.has(f.slug) && !!slugs.add(f.slug));
    console.log(` → ${fichas.length} leídas, ${unicas.length} slugs únicos`);
    porClase[clase] = unicas;
    checkpoint = undefined;
    guardarVolcado();
  }

  /**
   * SE FUSIONA CON LO QUE YA HUBIERA, NUNCA SE SUSTITUYE.
   *
   * Con `--solo=animes` solo se leen los animes, y guardar `porClase` a secas dejaba el volcado
   * con una sola clase: la corrida siguiente encontraba un volcado «fresco» sin películas y se
   * creía que no había nada que importar. Un fichero que existe para no perder trabajo no puede
   * ser la vía por la que se pierde.
   *
   * Es el mismo patrón que `seasons` —fusionar, no reemplazar—, que en este repositorio ya ha
   * costado tres fallos distintos.
   */
  const indice: Indice = { creado: new Date().toISOString(), porClase: { ...previo, ...porClase }, completo: true };
  try {
    fs.mkdirSync(path.dirname(VOLCADO), { recursive: true });
    fs.writeFileSync(VOLCADO, JSON.stringify(indice), 'utf8');
    console.log(`  volcado guardado en ${path.relative(process.cwd(), VOLCADO)}`);
  } catch (e: any) {
    console.log(`  (no se pudo guardar el volcado: ${e?.message})`);
  }
  return indice;
}

/**
 * Las obras que ya tenemos de este tipo: `tmdb_id` → id de la fila.
 *
 * Devuelve el ID y no solo el número porque `--rehacer` lo necesita: sin él, una ficha ya conocida
 * entraba por el camino de las nuevas, se le pedía a TMDB la metadata entera y acababa chocando
 * contra el UNIQUE `(tmdb_id, type)` para terminar, dando un rodeo, en el mismo `actualizarFicha`.
 * Funcionaba de casualidad y gastaba una petición de más por ficha.
 *
 * Paginado CON `.order()`: sin él, `.range()` se salta filas y da recuentos falsos —y estables,
 * que es lo que lo hace traicionero—.
 */
async function nuestrasFilas(type: ContentType): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('tmdb_id,id')
      .eq('type', type)
      .gt('tmdb_id', 0)
      .order('tmdb_id')
      .range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.set(Number(r.tmdb_id), String(r.id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IDENTIDAD
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ¿PODEMOS FIARNOS DEL `tmdb_id` QUE PROPONE ESTA FICHA?
 *
 * Una petición a TMDB por el id propuesto y el veredicto de `juzgarIdentidad`. Lo que se
 * contradice se descarta ENTERO: no se le busca otro id ni se le pone uno sintético. Un sintético
 * no choca con nada (FUENTES.md §4 ter) y la fila se escribiría como obra nueva — invisible,
 * porque sin `tmdb_id` positivo no se anuncia, pero ocupando sitio y con enlaces dentro. Basura
 * que habría que purgar después.
 */
async function identidadRespaldada(
  f: FichaLamoviebot,
  type: ContentType,
  /** Los embeds de la ficha: de ahí sale el SEGUNDO VOTO que juzga su `tmdb_id`. */
  embeds: EmbedLamoviebot[] = []
): Promise<{ ok: boolean; tmdbId: number; motivo: string }> {
  const id = Number(f.tmdb_id) || 0;
  if (!id) return { ok: false, tmdbId: 0, motivo: 'sin tmdb_id' };

  const r = await httpClient.get(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${id}`, {
    params: { api_key: TMDB_API_KEY, language: 'es-ES' },
    validateStatus: () => true,
    timeout: 15000,
  });
  if (r.status !== 200) return { ok: false, tmdbId: 0, motivo: `tmdb ${id} → HTTP ${r.status}` };

  const v = juzgarIdentidad(
    {
      year: f.year,
      title: f.title,
      slug: f.slug,
      idsDeEmbeds: embeds
        .map((e) => datosDeLaUrl(e.link))
        .filter(Boolean)
        .map((x) => (x as any).tmdbId as number),
    },
    {
      id,
      original_title: r.data.original_title || r.data.original_name,
      title: r.data.title || r.data.name,
      fecha: r.data.release_date || r.data.first_air_date,
    }
  );
  if (!respalda(v)) {
    return {
      ok: false,
      tmdbId: 0,
      motivo: `${v}: dice ${id} = "${r.data.title || r.data.name}" [${r.data.original_title || r.data.original_name}]`,
    };
  }
  return { ok: true, tmdbId: id, motivo: v };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VÍDEO
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ¿REPRODUCE ESTE EMBED? Resolver, bajar el manifiesto y descargar un segmento de verdad.
 *
 * Los tres pasos. Que `extractDirect` devuelva una url solo dice que se supo leer la página; que
 * el manifiesto baje solo dice que el CDN contesta. Lo que le importa a quien mira es que lleguen
 * bytes, y eso es el tercer paso.
 */
async function resolverYVerificar(
  embedUrl: string
): Promise<{ url: string; kind: 'hls' | 'mp4'; host: string } | null> {
  try {
    const r = await httpClient.get(embedUrl, {
      timeout: 20000,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
      headers: { 'User-Agent': UA_NAVEGADOR, Referer: REFERER_LAMOVIE },
      validateStatus: () => true,
    });
    if (r.status !== 200) return null;

    const directo = await extractDirect(embedUrl, String(r.data), { allowNetwork: true });
    if (!directo) return null;

    if (directo.kind === 'hls') {
      const manifiesto = await bajarManifiesto(directo.url, embedUrl);
      if (!manifiesto) return null;
      if (!(await segmentoDescargable(manifiesto, directo.url, embedUrl))) return null;
    }

    let host = '';
    try {
      host = new URL(directo.url).hostname;
    } catch {}
    return { url: directo.url, kind: directo.kind, host };
  } catch {
    return null;
  }
}

/**
 * El servidor que se guarda.
 *
 * `embed_url` es la url del HOST —`goodstream.one/embed-…`—, no la del Worker. Esa es la
 * diferencia que hace que la fuente pueda desaparecer sin llevarse el catálogo: el embed es de un
 * tercero y lo resolvemos nosotros. El `Referer` va puesto porque estos hosts cortan por
 * hotlinking, y sin él el vídeo que aquí se verifica daría 403 en el cliente.
 */
function servidorDeLamoviebot(
  embed: EmbedLamoviebot,
  directo: { url: string; kind: 'hls' | 'mp4'; host: string },
  etiqueta: string
): ServerOption {
  const ahora = new Date().toISOString();
  return {
    id: `lamoviebot-${etiqueta}-${embed.host.replace(/\./g, '-')}`,
    name: embed.server ? `LaMovie · ${embed.server}` : 'LaMovie',
    quality: embed.quality || '1080p',
    language: /ingl|dual|sub/i.test(embed.language || '') ? 'dual' : 'latino',
    embed_url: embed.link,
    direct_stream: directo.url,
    direct_kind: directo.kind,
    direct_host: directo.host,
    headers: { Referer: REFERER_LAMOVIE, 'User-Agent': UA_NAVEGADOR },
    status: 'online',
    last_checked: ahora,
    verified_at: ahora,
    source_id: 'lamoviebot',
  } as ServerOption;
}

/**
 * Resuelve los embeds de una ficha y devuelve los que REPRODUCEN, parando en cuanto hay
 * suficientes.
 *
 * Se para a propósito: una ficha con cinco hosts no necesita los cinco verificados para ser útil,
 * y verificarlos todos multiplica por cinco el coste de la corrida sobre un catálogo de 9.500
 * fichas. Los que no se verifican no se guardan — un servidor sin sello no lo anuncia
 * `paraElCliente`, así que guardarlo sin comprobar sería escribir algo invisible.
 */
async function servidoresQueReproducen(
  embeds: EmbedLamoviebot[],
  etiqueta: string,
  tope: number
): Promise<ServerOption[]> {
  const out: ServerOption[] = [];
  for (let i = 0; i < embeds.length && out.length < tope && quedaTiempo(); i += A_LA_VEZ) {
    const tanda = embeds.slice(i, i + A_LA_VEZ);
    const salidas = await Promise.all(
      tanda.map(async (e) => {
        const d = await resolverYVerificar(e.link);
        return d ? servidorDeLamoviebot(e, d, etiqueta) : null;
      })
    );
    for (const s of salidas) if (s && out.length < tope) out.push(s);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ESCRITURA
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function fichaDesdeTmdb(tmdbId: number, type: ContentType, slug: string): Promise<MediaItem | null> {
  const semilla: MediaItem = {
    id: idDeFicha(type, slug),
    tmdb_id: tmdbId,
    imdb_id: null,
    type,
    title: '',
    original_title: '',
    aliases: [],
    overview: '',
    rating: 0,
    genres: [],
    subcategories: [],
    poster: null,
    backdrop: null,
    logo: null,
    trailer: null,
    cast: [],
    dubbing_cast: [],
  };
  try {
    const ficha = await TmdbService.enrichMediaItem(semilla);
    if (!ficha || !(ficha.tmdb_id > 0) || !ficha.title) return null;
    return ficha;
  } catch {
    return null;
  }
}

function fusionarServidores(previos: any[], nuevos: ServerOption[]): any[] {
  const fuera = [...(previos || [])];
  for (const nuevo of nuevos) {
    const i = fuera.findIndex((s: any) => s?.embed_url === nuevo.embed_url || s?.id === nuevo.id);
    if (i >= 0) fuera[i] = { ...fuera[i], ...nuevo };
    else fuera.push(nuevo);
  }
  return fuera;
}

async function insertarFicha(
  ficha: MediaItem,
  servers: ServerOption[],
  seasons: any[],
  paginas: string[]
): Promise<boolean> {
  const ahora = new Date().toISOString();
  const fila: Record<string, unknown> = {
    id: ficha.id,
    tmdb_id: ficha.tmdb_id,
    imdb_id: ficha.imdb_id ?? null,
    type: ficha.type,
    title: ficha.title,
    original_title: ficha.original_title || ficha.title,
    title_normalized: searchIndexKey(ficha.title, ficha.original_title, ficha.aliases),
    aliases: ficha.aliases || [],
    tagline: ficha.tagline || '',
    overview: ficha.overview || '',
    rating: ficha.rating || 0,
    content_rating: ficha.content_rating || null,
    release_date: ficha.release_date || '',
    genres: ficha.genres || [],
    subcategories: ficha.subcategories || [],
    poster: ficha.poster,
    backdrop: ficha.backdrop,
    logo: ficha.logo,
    trailer: ficha.trailer,
    cast_data: (ficha.cast_details && ficha.cast_details.length ? ficha.cast_details : ficha.cast) || [],
    dubbing_cast_data: ficha.dubbing_cast || [],
    runtime: ficha.runtime ?? null,
    director: ficha.director || (ficha.created_by || []).join(', ') || null,
    metadata_source: ficha.metadata_source || 'tmdb',
    servers,
    seasons,
    total_seasons: ficha.total_seasons || seasons.length || 0,
    total_episodes: ficha.total_episodes || 0,
    source_url: paginas[0] || null,
    source_urls: paginas,
    has_streams: true,
    streams_updated_at: ahora,
    streams_checked_at: ahora,
    updated_at: ahora,
  };

  const { error } = await db.from('media_items').insert(fila);
  if (!error) return true;

  // La obra ya está con otro id de fila: se le AÑADE el servidor, nunca se sustituye.
  if (/duplicate key/i.test(error.message)) {
    const { data } = await db
      .from('media_items')
      .select('id')
      .eq('tmdb_id', ficha.tmdb_id)
      .eq('type', ficha.type)
      .limit(1);
    const yaEsta: any = data && data[0];
    if (yaEsta) return actualizarFicha(String(yaEsta.id), servers, seasons);
  }
  console.log(`   ! ${ficha.id}: ${error.message}`);
  cuenta.errores++;
  return false;
}

/** Le añade lo suyo a una ficha que ya existe, SIN PISAR NADA. */
async function actualizarFicha(id: string, servers: ServerOption[], seasonsNuevas: any[]): Promise<boolean> {
  const columnas = [servers.length ? 'servers' : '', seasonsNuevas.length ? 'seasons' : '']
    .filter(Boolean)
    .join(',');
  if (!columnas) return false;

  // Se lee JUSTO ANTES de fusionar: entre el índice y este momento otro escritor pudo añadir
  // capítulos, y fusionar sobre lo viejo sería pisarlos. `seasons` se fusiona, nunca se reemplaza.
  const { data: actual, error: errLectura } = await db
    .from('media_items')
    .select(columnas)
    .eq('id', id)
    .maybeSingle();
  if (errLectura) {
    console.log(`   ! ${id}: ${errLectura.message}`);
    cuenta.errores++;
    return false;
  }
  const guardado: any = actual || {};
  const ahora = new Date().toISOString();
  const update: Record<string, unknown> = {
    updated_at: ahora,
    streams_updated_at: ahora,
    streams_checked_at: ahora,
    has_streams: true,
  };
  if (servers.length) update.servers = fusionarServidores(guardado.servers || [], servers);
  if (seasonsNuevas.length) update.seasons = fusionarTemporadas(guardado.seasons || [], seasonsNuevas);

  const { error } = await db.from('media_items').update(update).eq('id', id);
  if (error) {
    console.log(`   ! ${id}: ${error.message}`);
    cuenta.errores++;
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TRABAJO
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Trabajo {
  clase: ClaseLamoviebot;
  type: ContentType;
  ficha: FichaLamoviebot;
  /** La fila que ya tenemos para esta obra, si la hay: entonces solo se le añaden servidores. */
  filaExistente?: string;
}

async function haremosPelicula(t: Trabajo): Promise<void> {
  const d = await detalle(t.clase, t.ficha.slug);
  const embeds = embedsDe(d);
  if (!embeds.length) {
    cuenta.sinVideo++;
    return;
  }

  const identidad = await identidadRespaldada({ ...t.ficha, ...d }, t.type, embeds);
  if (!identidad.ok) {
    cuenta.identidadRota++;
    console.log(`   ⊘ "${t.ficha.title}" (${t.ficha.year}) — ${identidad.motivo}`);
    return;
  }

  const servers = await servidoresQueReproducen(embeds, t.ficha.slug, 3);
  if (!servers.length) {
    cuenta.sinVideo++;
    return;
  }

  if (DRY) {
    t.filaExistente ? cuenta.fichasEnriquecidas++ : cuenta.fichasNuevas++;
    return;
  }

  if (t.filaExistente) {
    if (await actualizarFicha(t.filaExistente, servers, [])) cuenta.fichasEnriquecidas++;
    return;
  }
  const ficha = await fichaDesdeTmdb(identidad.tmdbId, t.type, t.ficha.slug);
  if (!ficha) {
    cuenta.sinTmdb++;
    return;
  }
  if (await insertarFicha(ficha, servers, [], [urlDeFicha(t.clase, t.ficha.slug)])) {
    cuenta.fichasNuevas++;
  }
}

async function haremosSerie(t: Trabajo): Promise<void> {
  const d = await detalle(t.clase, t.ficha.slug);
  const temporadas: any[] = Array.isArray(d?.temporadas) ? d.temporadas : [];
  if (!temporadas.length) return;

  /**
   * CADA CAPÍTULO CON SUS PROPIOS ENLACES, y por eso se pide el detalle de cada uno.
   *
   * FUENTES.md llama «el fallo peor sin dar error» a rellenar un capítulo con los enlaces de la
   * serie: pides el 1 y ves otro, y nadie se entera porque hay vídeo. Esta fuente publica una ruta
   * por episodio, así que no hay que defenderse con heurísticas — se le pregunta por el capítulo
   * concreto y lo que conteste es suyo. Al que no conteste no se le cuelga nada.
   */
  const pendientes: Array<{ temporada: number; capitulo: number }> = [];
  for (const temp of temporadas) {
    const nTemp = Number(temp?.season_number);
    if (!Number.isFinite(nTemp)) continue;
    for (const ep of temp?.episodios || []) {
      const nEp = Number(ep?.episode_number);
      if (Number.isFinite(nEp)) pendientes.push({ temporada: nTemp, capitulo: nEp });
    }
  }
  if (t.filaExistente && !REHACER) {
    const { data, error } = await db.from('media_items').select('seasons').eq('id', t.filaExistente).maybeSingle();
    if (error) throw new Error(error.message);
    const importados = new Set<string>();
    for (const temp of ((data as any)?.seasons || [])) {
      for (const ep of (temp?.episodes || [])) {
        if ((ep?.servers || []).some((s: any) => s?.source_id === 'lamoviebot'))
          importados.add(`${temp.season_number}x${ep.episode_number}`);
      }
    }
    for (let i = pendientes.length - 1; i >= 0; i--)
      if (importados.has(`${pendientes[i].temporada}x${pendientes[i].capitulo}`)) pendientes.splice(i, 1);
  }
  if (!pendientes.length) return;
  const aTrabajar = pendientes
    .sort((a, b) => a.temporada - b.temporada || a.capitulo - b.capitulo)
    .slice(0, CAPITULOS_POR_SERIE === SIN_TOPE ? pendientes.length : CAPITULOS_POR_SERIE);

  /**
   * LA IDENTIDAD SE JUZGA CON LOS EMBEDS DEL PRIMER CAPÍTULO, y no con los de la ficha.
   *
   * Una ficha de serie de esta fuente NO trae embeds —los traen sus capítulos—, así que juzgándola
   * a ella el segundo voto (el `tmdb_id` escrito dentro de su reproductor de `videoapp.zip`) no
   * existía nunca y toda serie caía al camino flojo del slug. El primer capítulo hay que pedirlo
   * de todas formas, así que el voto sale gratis: se pide una vez, se usa para juzgar y se reutiliza
   * para resolver.
   */
  const primero = aTrabajar[0];
  let dPrimero: any = null;
  if (primero) {
    try {
      dPrimero = await detalleEpisodio(t.clase, t.ficha.slug, primero.temporada, primero.capitulo);
    } catch {}
  }

  const identidad = await identidadRespaldada({ ...t.ficha, ...d }, t.type, dPrimero ? embedsDe(dPrimero) : []);
  if (!identidad.ok) {
    cuenta.identidadRota++;
    console.log(`   ⊘ "${t.ficha.title}" (${t.ficha.year}) — ${identidad.motivo}`);
    return;
  }

  // La ficha antes de resolver el resto: escribir capítulos de algo que no se va a poder guardar
  // sería tirar peticiones.
  let ficha: MediaItem | null = null;
  if (!t.filaExistente) {
    ficha = await fichaDesdeTmdb(identidad.tmdbId, t.type, t.ficha.slug);
    if (!ficha) {
      cuenta.sinTmdb++;
      return;
    }
  }

  const resueltos: Array<{ temporada: number; capitulo: number; servers: ServerOption[] }> = [];
  for (const c of aTrabajar) {
    if (!quedaTiempo()) break;
    try {
      const dEp =
        primero && c.temporada === primero.temporada && c.capitulo === primero.capitulo && dPrimero
          ? dPrimero
          : await detalleEpisodio(t.clase, t.ficha.slug, c.temporada, c.capitulo);
      const embeds = embedsDe(dEp);
      if (!embeds.length) continue;
      const servers = await servidoresQueReproducen(embeds, `${t.ficha.slug}-${c.temporada}x${c.capitulo}`, 2);
      if (servers.length) resueltos.push({ ...c, servers });
    } catch {
      // Un capítulo que no contesta no invalida la serie: se sigue con los demás.
    }
  }

  if (!resueltos.length) {
    cuenta.sinVideo++;
    return;
  }

  const ahora = new Date().toISOString();
  const porTemporada = new Map<number, any[]>();
  for (const r of resueltos) {
    const lista = porTemporada.get(r.temporada) || [];
    lista.push({ episode_number: r.capitulo, servers: r.servers, checked_at: ahora });
    porTemporada.set(r.temporada, lista);
  }
  const seasons = [...porTemporada.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, episodes]) => ({
      season_number: n,
      episodes: episodes.sort((a, b) => a.episode_number - b.episode_number),
    }));

  if (DRY) {
    cuenta.capitulos += resueltos.length;
    t.filaExistente ? cuenta.fichasEnriquecidas++ : cuenta.fichasNuevas++;
    return;
  }

  const apuntar = () => {
    cuenta.capitulos += resueltos.length;
  };
  if (t.filaExistente) {
    if (await actualizarFicha(t.filaExistente, [], seasons)) {
      cuenta.fichasEnriquecidas++;
      apuntar();
    }
  } else if (ficha) {
    // Los rótulos de TMDB primero y los enlaces encima: si no, los capítulos se llaman
    // «SERIE 1x1» y la ficha acaba con metadata de la web (FUENTES.md §4 bis, quinto camino).
    const conRotulos = fusionarTemporadas((ficha as any).seasons || [], seasons);
    if (await insertarFicha(ficha, [], conRotulos.length ? conRotulos : seasons, [
      urlDeFicha(t.clase, t.ficha.slug),
    ])) {
      cuenta.fichasNuevas++;
      apuntar();
    }
  }
}

async function main() {
  console.log(`IMPORTANDO LAMOVIE${DRY ? ' (--dry, no escribe)' : ''}\n`);
  const indice = await obtenerIndice();

  const cola: Trabajo[] = [];
  for (const { clase, type } of CLASES) {
    if (SOLO && SOLO !== clase) continue;
    const fichas = indice.porClase[clase] || [];
    if (!fichas.length) continue;
    const yaTenemos = await nuestrasFilas(type);

    for (const f of fichas) {
      if (SLUGS.length && !SLUGS.includes(f.slug)) continue;
      const id = Number(f.tmdb_id) || 0;
      const filaExistente = id > 0 ? yaTenemos.get(id) : undefined;
      // Una serie existente puede tener solo los primeros 12 capítulos de la pasada inicial.
      // La función de serie resta los capítulos que ya tienen servidor de esta fuente.
      if (filaExistente && type === 'movie' && !REHACER) continue;
      cola.push({ clase, type, ficha: f, filaExistente });
    }
  }

  /**
   * Las que traen `tmdb_id` delante, y las que no, al final.
   *
   * Sin `--rehacer` la cola YA excluye lo que tenemos, así que aquí no se separa lo nuevo de lo
   * viejo —todo es nuevo—: se separa lo que se puede llegar a escribir de lo que casi seguro no.
   * Una ficha sin `tmdb_id` no pasa `identidadRespaldada` y se descarta, así que gastar en ella el
   * final de una tanda cortada por tiempo es gastarlo en nada.
   */
  cola.sort((a, b) => (a.ficha.tmdb_id ? 0 : 1) - (b.ficha.tmdb_id ? 0 : 1));
  // La cola incluye series existentes. Un cursor de vuelta evita que 200 series ya completas
  // ocupen siempre toda la tanda y dejen el resto sin visitar.
  const claveCursor = `lamoviebot_cursor_${SOLO || 'todos'}`;
  const { data: cursorGuardado } = await db.from('esquema').select('valor').eq('clave', claveCursor).maybeSingle();
  const desde = SLUGS.length ? 0 : (Number((cursorGuardado as any)?.valor) || 0) % Math.max(1, cola.length);
  const ordenada = [...cola.slice(desde), ...cola.slice(0, desde)];
  const tanda = ordenada.slice(0, LIMITE === SIN_TOPE ? ordenada.length : LIMITE);
  console.log(`\nCola: ${cola.length} fichas pendientes · esta tanda: ${tanda.length}\n`);

  let visitadas = 0;
  for (const t of tanda) {
    if (!quedaTiempo()) {
      console.log('\n(se acabó el tiempo de la tanda)');
      break;
    }
    try {
      if (t.type === 'movie') await haremosPelicula(t);
      else await haremosSerie(t);
    } catch (e: any) {
      cuenta.errores++;
      console.log(`   ! ${t.ficha.slug}: ${e?.message}`);
    }
    visitadas++;
  }
  if (!DRY && !SLUGS.length && cola.length && visitadas) {
    const { error } = await db.from('esquema').upsert({ clave: claveCursor, valor: String((desde + visitadas) % cola.length) }, { onConflict: 'clave' });
    if (error) throw new Error(`No se pudo guardar cursor Lamoviebot: ${error.message}`);
  }

  console.log(
    `\nRESULTADO${DRY ? ' (simulado)' : ''}\n` +
      `  fichas nuevas:        ${cuenta.fichasNuevas}\n` +
      `  fichas enriquecidas:  ${cuenta.fichasEnriquecidas}\n` +
      `  capítulos:            ${cuenta.capitulos}\n` +
      `  sin vídeo que valga:  ${cuenta.sinVideo}\n` +
      `  sin ficha de TMDB:    ${cuenta.sinTmdb}\n` +
      `  IDENTIDAD RECHAZADA:  ${cuenta.identidadRota}   ← su tmdb_id se contradecía; no se escribió\n` +
      `  errores:              ${cuenta.errores}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
