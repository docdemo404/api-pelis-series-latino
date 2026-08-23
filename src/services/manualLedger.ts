/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EL LIBRO DE LO PUESTO A MANO. Una copia que ningún escritor del catálogo toca.
 *
 * Este fichero existe porque el mismo fallo ha vuelto CUATRO veces, cada vez por una puerta
 * distinta, y siempre con el mismo aspecto: «los datos de la fuente propia no persisten».
 *
 *   · `persistStreams` reemplazaba `servers` con lo que acababa de resolver el rastreo.
 *   · el crawl (`refreshCatalog`) reemplazaba la fila entera.
 *   · `escribirServidoresDelCapitulo` reemplazaba los servidores del capítulo.
 *   · `verificarPermanentes` BORRABA los que no tuvieran forma de fichero permanente.
 *
 * Los cuatro se arreglaron uno a uno, y cada arreglo era una copia de la misma regla —«rescata
 * los manuales antes de escribir»— metida en un sitio más. Eso ya sabemos cómo acaba, está
 * escrito en este mismo proyecto: **lo que se copia se desincroniza; lo que se llama, no.** Y no
 * es solo desincronizarse: basta con que alguien añada un quinto escritor —o un `UPDATE` a mano en
 * el SQL Editor— para volver a perderlo todo, porque la regla no vive en el dato, vive en quien
 * escribe.
 *
 * ─── La diferencia de este arreglo ───────────────────────────────────────────────────────────
 *
 * Una url pegada por una persona y un servidor scrapeado NO son el mismo tipo de dato:
 *
 *   · el scrapeado se REGENERA. Si se pierde, la siguiente pasada lo vuelve a traer.
 *   · el manual no lo redescubre nadie. Si se pierde, se perdió — y encima en silencio, porque
 *     nadie va a comprobar si su url sigue ahí hasta que le da a Reproducir.
 *
 * Compartir celda con lo que se regenera es lo que los mata: cada escritor reemplaza la columna
 * entera y no puede saber lo que no escribió. Así que se guardan APARTE, en `manual_servers`, y
 * esa columna la escribe **solo el panel**. Todo lo demás —crawl, barridos, reparaciones, la API—
 * puede seguir haciendo exactamente lo que hacía con `servers` y `seasons`: si se lleva un manual
 * por delante, la siguiente lectura lo devuelve a su sitio desde el libro.
 *
 * O sea que ya no hay que acordarse de nada al ESCRIBIR. La garantía está en el LEER, que es un
 * solo sitio (`mapDbItemToMediaItem`), y en el barrido que pasa por todas las filas.
 *
 * ─── Lo que NO hace, y es a propósito ────────────────────────────────────────────────────────
 *
 * **No devuelve el sello.** Lo que se recupera vuelve sin `verified_at`, así que no se publica
 * hasta que el verificador vuelva a demostrar que entrega vídeo. Si no, esto resucitaría enlaces
 * muertos: un servidor al que se le quitó el sello CON PRUEBA volvería sellado a la vuelta
 * siguiente, y el libro pasaría de proteger a mentir. Recuperar la dirección es gratis; volver a
 * anunciarla cuesta una comprobación, como todo en este catálogo.
 *
 * **No pisa lo que ya está.** Si la url sigue en la fila, manda la copia de la fila: ahí es donde
 * viven las mediciones (`kbps`, `max_height`), el sello y el `status` de hoy. El libro solo aporta
 * lo que FALTA.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { ServerOption } from '../types';
import { ficheroDentroDeNuestraCache } from '../utils/externalProxy';

/** Lo que se guarda en la columna `manual_servers`. */
export interface LedgerManual {
  /** Urls de la ficha (una película se reproduce por aquí). */
  ficha: ServerOption[];
  /** Urls por capítulo (una serie se reproduce por aquí). */
  capitulos: Array<{ season: number; episode: number; servers: ServerOption[] }>;
}

export const LEDGER_VACIO: LedgerManual = { ficha: [], capitulos: [] };

/** Qué cuenta como puesto a mano. Un solo sitio, para que no haya dos criterios. */
export function esManual(sv: any): boolean {
  return String(sv?.source_id || '').toLowerCase() === 'manual';
}

/**
 * El fichero que hay dentro de una url de caché, MIRANDO SOLO LA CADENA.
 *
 * `ficheroDentroDeNuestraCache` hace esto mismo pero exige la FIRMA, y con razón: allí el
 * resultado se usa para ir a buscar bytes, así que aceptar cualquier `e=` convertiría la API en un
 * relé abierto. Aquí no se descarga nada — solo se compara — y depender de la firma tenía un
 * efecto muy concreto y muy malo: en un proceso SIN las variables del Worker (un runner, un script
 * local) la url envuelta no se puede desenvolver, así que el mismo fichero parece dos servidores
 * distintos.
 *
 * Y no es teórico: la ficha manual de Shrek acabó con su mp4 DOS veces, con el mismo id de
 * servidor —una con la url de archive.org y otra con la de la caché—, porque el rescate de turno
 * comparó las dos formas como cadenas. Medido el 2026-08-23.
 */
function ficheroEnvuelto(url: string): string | null {
  const m = /\/v\?e=([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return null;
  try {
    const dentro = Buffer.from(m[1], 'base64url').toString('utf8');
    return /^https?:\/\//i.test(dentro) ? dentro : null;
  } catch {
    return null;
  }
}

/**
 * La CLAVE de un servidor: la url del fichero, desenvuelta.
 *
 * No se puede comparar `direct_stream` a pelo. Lo que se persiste se fosiliza, y la url que acaba
 * en la base puede ser ya la de la caché por trozos (`…/v?e=<fichero>`), mientras que en el libro
 * está la del origen. Comparándolas tal cual, el mismo servidor parece dos y el libro lo
 * re-inyectaría duplicado en cada lectura.
 */
export function claveDeServidor(sv: any): string {
  const url = String(sv?.direct_stream || sv?.embed_url || '');
  if (!url) return '';
  return ficheroDentroDeNuestraCache(url) || ficheroEnvuelto(url) || url;
}

/**
 * UNA ENTRADA POR FICHERO, y en su forma de ORIGEN.
 *
 * Dos copias del mismo vídeo no son dos respaldos: son el mismo servidor contado dos veces, que
 * ocupa un puesto en la lista y se gasta un intento de la app cuando falla — falla en los dos.
 *
 * Se conserva la primera aparición (el orden de la fuente propia importa: la primera es la que se
 * reproduce) y se le pone la url del ORIGEN si alguna de sus copias la traía. El origen es la
 * forma estable; la envuelta es un detalle de cómo se entregó ese día, y guardarla como si fuera
 * la dirección del vídeo es lo que ata el dato a que el Worker siga existiendo.
 *
 * De los campos medidos —el sello, `kbps`, `max_height`— se queda con los de la copia que los
 * tenga: son mediciones del mismo fichero, y tirarlas obligaría a repetirlas.
 */
export function unaPorFichero<T extends Record<string, any>>(servidores: T[]): T[] {
  const porClave = new Map<string, T>();
  const orden: string[] = [];

  for (const sv of servidores || []) {
    const k = claveDeServidor(sv);
    if (!k) continue;
    const previo = porClave.get(k);
    if (!previo) {
      porClave.set(k, { ...sv });
      orden.push(k);
      continue;
    }
    // Ya había una copia: se completa con lo que esta traiga y no estuviera.
    const fundido: any = { ...previo };
    for (const campo of ['verified_at', 'kbps', 'kbps_necesarios', 'max_height', 'ttfb_ms', 'direct_kind', 'quality', 'language']) {
      if (fundido[campo] === undefined && sv[campo] !== undefined) fundido[campo] = sv[campo];
    }
    porClave.set(k, fundido);
  }

  // Y la url del origen manda sobre la envuelta, venga de la copia que venga.
  return orden.map(k => {
    const sv: any = porClave.get(k);
    return (sv.direct_stream && ficheroEnvuelto(String(sv.direct_stream)) ? { ...sv, direct_stream: k } : sv) as T;
  });
}

const claveDeCapitulo = (season: unknown, episode: unknown) => `${Number(season)}x${Number(episode)}`;

/**
 * Todo lo manual que hay HOY en una fila, listo para guardarlo como libro.
 *
 * Se llama justo después de que el panel escriba: el libro es la foto de lo que el panel dejó, y
 * por eso borrar sigue funcionando sin ningún mecanismo aparte — lo que el formulario quitó de la
 * fila deja de estar en la foto siguiente.
 */
export function extraerManuales(fila: {
  servers?: any[] | null;
  seasons?: any[] | null;
}): LedgerManual {
  // El libro se guarda ya limpio: si la fila trae el mismo fichero dos veces, en el libro entra
  // una. Ver `unaPorFichero`.
  const ficha = unaPorFichero(((fila?.servers || []) as any[]).filter(esManual));
  const capitulos: LedgerManual['capitulos'] = [];

  for (const t of (fila?.seasons || []) as any[]) {
    for (const e of (t?.episodes || []) as any[]) {
      const suyos = unaPorFichero(((e?.servers || []) as any[]).filter(esManual));
      if (!suyos.length) continue;
      capitulos.push({
        season: Number(t?.season_number ?? e?.season_number),
        episode: Number(e?.episode_number),
        servers: suyos,
      });
    }
  }

  return { ficha, capitulos };
}

/** Lee la columna con cuidado: puede no existir todavía, o venir de otra versión. */
export function leerLedger(valor: unknown): LedgerManual {
  if (!valor || typeof valor !== 'object') return LEDGER_VACIO;
  const v = valor as any;
  const ficha = Array.isArray(v.ficha) ? (v.ficha as ServerOption[]) : [];
  const capitulos = Array.isArray(v.capitulos)
    ? (v.capitulos as any[])
        .filter(c => c && Number.isFinite(Number(c.season)) && Number.isFinite(Number(c.episode)))
        .map(c => ({
          season: Number(c.season),
          episode: Number(c.episode),
          servers: Array.isArray(c.servers) ? (c.servers as ServerOption[]) : [],
        }))
    : [];
  return { ficha, capitulos };
}

export function ledgerVacio(l: LedgerManual): boolean {
  return !l.ficha.length && !l.capitulos.some(c => c.servers.length);
}

/**
 * Cómo vuelve un servidor recuperado: con su dirección y SIN su sello.
 *
 * `verified_at` fuera y `status` a `online` para que el verificador lo mire —lo `offline` no se
 * sondea en el camino de una petición—, pero sin sello no se publica. O sea: vuelve a estar, no
 * vuelve a anunciarse. Lo segundo lo tiene que ganar otra vez.
 *
 * `fallos_arranque` también se borra: es la cuenta de golpes del barrido y pertenece a una
 * comprobación que ya no aplica a un servidor que acaba de reaparecer.
 */
function comoVuelve(sv: ServerOption): ServerOption {
  const { verified_at, fallos_arranque, ...resto } = sv as any;
  return { ...resto, status: 'online' } as ServerOption;
}

export interface Fusion {
  servers: any[];
  seasons: any[];
  /** Cuántas urls faltaban y se han devuelto. Cero significa que la fila estaba bien. */
  recuperados: number;
  /** Cuántas copias repetidas del mismo fichero se han colapsado. Ver `unaPorFichero`. */
  duplicados: number;
}

/** Deja una entrada manual por fichero, sin tocar ni mover a los servidores scrapeados. */
function sinRepetidos(servidores: any[]): { lista: any[]; claves: Set<string>; duplicados: number } {
  const lista: any[] = [];
  const claves = new Set<string>();
  let duplicados = 0;

  for (const sv of servidores) {
    if (!esManual(sv)) { lista.push(sv); continue; }
    const k = claveDeServidor(sv);
    if (k && claves.has(k)) { duplicados++; continue; }
    if (k) claves.add(k);
    lista.push(sv);
  }

  return { lista, claves, duplicados };
}

/**
 * Devuelve a su sitio lo que el libro tiene y la fila ha perdido.
 *
 * Se conserva el ORDEN de la fuente propia: los manuales van delante, que es donde los pone el
 * panel y lo que espera quien pegó la url.
 *
 * Un capítulo que ya no existe en el árbol NO se inventa: si la serie se re-scrapeó y ese episodio
 * desapareció, meterlo aquí crearía un capítulo fantasma. Se cuenta como no recuperado y el
 * auditor lo dirá.
 */
export function fusionarConLedger(
  fila: { servers?: any[] | null; seasons?: any[] | null },
  ledger: LedgerManual
): Fusion {
  const original = Array.isArray(fila?.servers) ? fila.servers : [];
  const seasons = Array.isArray(fila?.seasons) ? fila.seasons : [];
  let recuperados = 0;
  let duplicados = 0;

  // Primero se quitan las copias repetidas del mismo fichero, y de paso salen las claves de lo que
  // ya hay. Así el libro no re-inyecta algo que estaba ahí con otra forma de url.
  const limpio = sinRepetidos(original);
  const servers = limpio.lista;
  duplicados += limpio.duplicados;

  if (ledger.ficha.length) {
    const faltan = ledger.ficha.filter(sv => {
      const k = claveDeServidor(sv);
      return k && !limpio.claves.has(k);
    });
    if (faltan.length) {
      recuperados += faltan.length;
      servers.unshift(...unaPorFichero(faltan).map(comoVuelve));
    }
  }

  const porCapitulo = new Map<string, ServerOption[]>();
  for (const c of ledger.capitulos) {
    if (c.servers.length) porCapitulo.set(claveDeCapitulo(c.season, c.episode), c.servers);
  }

  let seasonsFinales = seasons;
  if (Array.isArray(seasons) && seasons.length) {
    let tocado = false;
    seasonsFinales = seasons.map((t: any) => {
      const episodios = (t?.episodes || []) as any[];
      let tocadaLaTemporada = false;
      const nuevos = episodios.map((e: any) => {
        const suyos = porCapitulo.get(claveDeCapitulo(t?.season_number ?? e?.season_number, e?.episode_number)) || [];
        const actuales = Array.isArray(e?.servers) ? e.servers : [];
        // La limpieza de repetidos va en TODOS los capítulos, tengan o no algo en el libro: un
        // capítulo puede haber acumulado dos copias del mismo fichero sin que falte nada.
        const limpioCap = sinRepetidos(actuales);
        if (limpioCap.duplicados) {
          duplicados += limpioCap.duplicados;
          tocadaLaTemporada = true;
        }
        const faltan = suyos.filter(sv => {
          const k = claveDeServidor(sv);
          return k && !limpioCap.claves.has(k);
        });
        if (!faltan.length) return limpioCap.duplicados ? { ...e, servers: limpioCap.lista } : e;
        recuperados += faltan.length;
        tocadaLaTemporada = true;
        return { ...e, servers: [...unaPorFichero(faltan).map(comoVuelve), ...limpioCap.lista] };
      });
      if (!tocadaLaTemporada) return t;
      tocado = true;
      return { ...t, episodes: nuevos };
    });
    if (!tocado) seasonsFinales = seasons;
  }

  return { servers, seasons: seasonsFinales, recuperados, duplicados };
}

/**
 * Todo lo manual de un libro en una sola lista. Para quien solo necesita las urls —el rescate de
 * `persistStreams`, la auditoría— sin importarle de qué capítulo cuelga cada una.
 */
export function todoElLedger(l: LedgerManual): ServerOption[] {
  return [...l.ficha, ...l.capitulos.flatMap(c => c.servers)];
}
