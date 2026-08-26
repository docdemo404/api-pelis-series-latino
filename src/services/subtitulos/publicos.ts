/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUSCAR UN SUBTÍTULO YA ESCRITO POR UNA PERSONA
 *
 * Es el parche mientras la transcripción llega. Escuchar una película entera son decenas de
 * minutos de runner; bajarse un fichero son dos segundos, y además está escrito por alguien que
 * sabía lo que oía —los nombres propios salen bien, los acentos cerrados también—.
 *
 * NADA DE LO QUE SALE DE AQUÍ SE PUBLICA TAL CUAL. Todo pasa antes por `medirEncaje`, que
 * comprueba contra el audio de ESTA copia si el fichero es del mismo montaje. Este módulo solo
 * consigue candidatos; quien decide es el comparador.
 *
 * ── EL LÍMITE QUE HAY QUE TENER EN CUENTA ──────────────────────────────────────────────────
 *
 * OpenSubtitles pide una clave y su plan gratuito da para unas pocas descargas al día. No es un
 * detalle menor: significa que esto NO puede ser la vía principal, solo el adelanto para lo que
 * alguien acaba de pedir. Por eso está escrito como una lista de buscadores y no como una llamada
 * suelta — el día que haya otra fuente, entra aquí y el resto no se entera.
 *
 * Y si no hay clave, no falla: devuelve vacío y la ficha se va derecha a la cola de transcripción,
 * que es el camino que de todas formas tenía que existir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Candidato {
  /** Con qué buscador se consiguió, para poder culpar al correcto en el registro. */
  buscador: string;
  /** Lo que hay que pedirle a ese buscador para bajarlo. */
  referencia: string;
  /** Nombre del fichero o del montaje, tal cual lo publica el banco. Solo para el registro. */
  nombre: string;
  /** Cuánta gente lo ha bajado. A igualdad de todo lo demás, el más bajado suele ser el bueno. */
  descargas: number;
}

export interface Peticion {
  imdbId?: string | null;
  tmdbId?: number | null;
  /** 'en' | 'es'. */
  idioma: string;
  /** En series, para pedir el capítulo y no la temporada entera. */
  temporada?: number | null;
  capitulo?: number | null;
}

const OPENSUBTITLES = 'https://api.opensubtitles.com/api/v1';

/** Sin clave no hay búsqueda, y eso NO es un error: es el modo en el que arranca el proyecto. */
function claveDeOpenSubtitles(): string | null {
  return process.env.OPENSUBTITLES_API_KEY?.trim() || null;
}

function cabeceras(clave: string): Record<string, string> {
  return {
    'Api-Key': clave,
    // La API rechaza las peticiones sin un agente propio, y pide que lleve versión.
    'User-Agent': process.env.OPENSUBTITLES_AGENT?.trim() || 'api-pelis-series-latino v1.0',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Los candidatos que hay para esta ficha, del más prometedor al menos.
 *
 * Se piden solo los que declaran estar sincronizados con un vídeo (`moviehash_match` aparte, que
 * requeriría tener el fichero entero) y se ordenan por descargas: el criterio no es que sea el
 * correcto —eso lo dice el comparador— sino cuál probar primero para gastar menos cuota.
 */
export async function buscarPublicos(peticion: Peticion): Promise<Candidato[]> {
  const clave = claveDeOpenSubtitles();
  if (!clave) return [];

  const parametros = new URLSearchParams({ languages: peticion.idioma, order_by: 'download_count' });
  if (peticion.imdbId) parametros.set('imdb_id', peticion.imdbId.replace(/^tt/, ''));
  else if (peticion.tmdbId) parametros.set('tmdb_id', String(peticion.tmdbId));
  else return [];

  if (peticion.temporada) parametros.set('season_number', String(peticion.temporada));
  if (peticion.capitulo) parametros.set('episode_number', String(peticion.capitulo));

  try {
    const r = await fetch(`${OPENSUBTITLES}/subtitles?${parametros}`, {
      headers: cabeceras(clave),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];

    const datos: any = await r.json();
    return (datos?.data || [])
      .map((fila: any): Candidato | null => {
        const fichero = fila?.attributes?.files?.[0];
        if (!fichero?.file_id) return null;
        return {
          buscador: 'opensubtitles',
          referencia: String(fichero.file_id),
          nombre: String(fichero.file_name || fila?.attributes?.release || 'sin nombre'),
          descargas: Number(fila?.attributes?.download_count) || 0,
        };
      })
      .filter(Boolean)
      .slice(0, 5) as Candidato[];
  } catch {
    // Que el banco no conteste no es un fallo de nada: se transcribe y ya está.
    return [];
  }
}

/**
 * Baja el fichero de un candidato. Devuelve el texto tal cual, sin tocarlo.
 *
 * Consume cuota: la API entrega un enlace de un solo uso y lo descuenta del día. Por eso quien
 * llama prueba de uno en uno y para en cuanto uno pasa la comprobación, en vez de bajarse los
 * cinco para elegir.
 */
export async function descargarPublico(candidato: Candidato): Promise<string | null> {
  const clave = claveDeOpenSubtitles();
  if (!clave || candidato.buscador !== 'opensubtitles') return null;

  try {
    const r = await fetch(`${OPENSUBTITLES}/download`, {
      method: 'POST',
      headers: cabeceras(clave),
      body: JSON.stringify({ file_id: Number(candidato.referencia) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;

    const datos: any = await r.json();
    const enlace = datos?.link;
    if (!enlace) return null;

    const fichero = await fetch(enlace, { signal: AbortSignal.timeout(30_000) });
    if (!fichero.ok) return null;

    return await fichero.text();
  } catch {
    return null;
  }
}
