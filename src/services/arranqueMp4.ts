/**
 * ¿SE PUEDE ABRIR ESTE MP4? Se pregunta igual que lo pregunta el reproductor.
 *
 * Existe porque «el fichero está» y «la película se puede ver» resultaron ser dos cosas distintas,
 * y el catálogo llevaba tiempo comprobando solo la primera. `sigueVivo` pide un rango de en medio
 * y con un `206` da el servidor por bueno — y es una comprobación correcta: demuestra que el
 * fichero existe y que el host sabe posicionarse. Lo que NO demuestra es que alguien pueda darle a
 * Ver y ver algo.
 *
 * Un mp4 no se abre sin su ÍNDICE (la caja `moov`), y ahí están los dos problemas que el catálogo
 * no veía:
 *
 *   · El índice puede pesar varios megas —6,5 MB en una película de dos horas—, y en un origen
 *     lento traerlo entero puede pasarse del tiempo que el reproductor espera. El fichero está, el
 *     rango funciona, y aun así la pantalla se queda en negro.
 *   · El índice puede estar AL FINAL del fichero, detrás del vídeo. Los de archive.org suelen
 *     estarlo. Entonces lo primero que hace el reproductor es un salto de cientos de megas, que es
 *     una segunda petición lenta antes del primer fotograma.
 *
 * Y hay un tercer caso que ninguna comprobación de rangos puede detectar: ficheros ROTOS. Una caja
 * del mp4 que dice acabar más allá del final del fichero es basura, se sirva como se sirva. Se vio
 * uno en el catálogo: decía acabar en el byte 440.786.851 de un fichero de 370.946.610.
 *
 * Se mide con el mismo plazo que aguanta la app (ver `ARRANQUE_MS` en `VodPlayback`), porque la
 * pregunta no es si el fichero es alcanzable en abstracto: es si lo es ANTES de que quien está
 * mirando se encuentre un error.
 */

/** Lo que el reproductor espera antes de dar una fuente por perdida. */
const PACIENCIA_MS = 25_000;

/** Un índice más grande que esto no es un índice: es que se leyó mal el fichero. */
const INDICE_MAX = 64 * 1024 * 1024;

export interface Arranque {
  ok: boolean;
  /** Corta y agrupable: es lo que se cuenta al medir el catálogo entero. */
  causa: string;
  detalle: string;
  /**
   * Cierto cuando no se pudo concluir NADA —el origen no contestó a tiempo—, y entonces esto no
   * condena a nadie. Mismo criterio que el resto del verificador: lento no es roto.
   */
  sinVeredicto?: boolean;
}

async function pedir(url: string, desde: number, hasta?: number) {
  const rango = hasta === undefined ? `bytes=${desde}-` : `bytes=${desde}-${hasta}`;
  return fetch(url, { headers: { Range: rango }, signal: AbortSignal.timeout(PACIENCIA_MS) });
}

/** Lee como mucho `tope` bytes y corta la descarga. */
async function leerHasta(r: Response, tope: number): Promise<Uint8Array> {
  const lector = r.body!.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    partes.push(value);
    total += value.length;
    if (total >= tope) { await lector.cancel().catch(() => {}); break; }
  }
  const junto = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { junto.set(p, o); o += p.length; }
  return junto;
}

/** El tamaño del fichero según la respuesta, o 0 si no lo dice. */
function totalDe(r: Response): number {
  const cr = r.headers.get('content-range') || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  if (m) return Number(m[1]);
  const cl = Number(r.headers.get('content-length'));
  return Number.isFinite(cl) && cl > 0 ? cl : 0;
}

/**
 * RECORRE LA CADENA DE CAJAS HASTA ENCONTRAR EL ÍNDICE, con lecturas pequeñas.
 *
 * La primera versión leía medio mega del principio y buscaba el `moov` ahí dentro. Suena
 * razonable y acusaba a películas sanas de estar rotas, dos veces seguidas:
 *
 *   · Un mp4 puede llevar un `free` enorme entre medias. «El Conjuro 4» tiene uno de 4 MB justo
 *     detrás del `ftyp`, así que en medio mega no se llega ni a la caja siguiente.
 *   · Y el `mdat` puede medir gigas, con lo cual el índice que va detrás cae fuera de cualquier
 *     ventana razonable.
 *
 * En los dos casos la conclusión que salía era «índice de 3 GB», o sea basura, y con esa basura se
 * iba a RETIRAR la película del catálogo. Un falso positivo aquí borra cosas que se veían bien.
 *
 * Recorrer la cadena cuesta unos pocos bytes por salto —una cabecera de caja son 16— y da la
 * respuesta exacta esté donde esté el índice. Y solo hay una forma de concluir que un fichero está
 * ROTO, que es la de verdad: que la cadena se salga del final del fichero.
 */
async function localizarIndice(
  url: string,
  total: number
): Promise<
  | { ok: true; indiceEn: number; indiceTam: number; delante: boolean }
  | { ok: false; veredicto: Arranque }
> {
  /** Tope de saltos. Un mp4 normal resuelve esto en dos o tres; más es que algo va mal. */
  const SALTOS_MAX = 10;

  let posicion = 0;
  for (let salto = 0; salto < SALTOS_MAX; salto++) {
    if (posicion >= total) {
      return {
        ok: false,
        veredicto: {
          ok: false,
          causa: 'fichero roto',
          detalle: `la cadena de cajas se sale: ${posicion} de ${total}`,
        },
      };
    }

    let r: Response;
    try {
      r = await pedir(url, posicion, posicion + 15);
    } catch (e: any) {
      return { ok: false, veredicto: noSeSabe('no se puede leer la cabecera', e?.message || String(e)) };
    }
    if (!r.ok || !r.body) {
      return { ok: false, veredicto: noSeSabe(`la cabecera da ${r.status}`, `en el byte ${posicion}`) };
    }

    const d = await leerHasta(r, 16);
    if (d.length < 8) {
      return { ok: false, veredicto: noSeSabe('cabecera corta', `${d.length} bytes en ${posicion}`) };
    }

    const vista = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const declarado = vista.getUint32(0);
    const tipo = String.fromCharCode(d[4], d[5], d[6], d[7]);

    let tam = declarado;
    if (declarado === 1) {
      // Tamaño de 64 bits: el formato lo usa para cajas de más de 4 GB, y el `mdat` de una
      // película en alta definición lo usa constantemente.
      if (d.length < 16) {
        return { ok: false, veredicto: noSeSabe('cabecera corta', 'sin los 8 bytes del tamaño largo') };
      }
      tam = vista.getUint32(8) * 4294967296 + vista.getUint32(12);
    } else if (declarado === 0) {
      // «Hasta el final del fichero».
      tam = total - posicion;
    }

    if (tipo === 'moov') {
      if (tam < 8 || tam > INDICE_MAX) {
        return { ok: false, veredicto: { ok: false, causa: 'fichero roto', detalle: `índice de ${tam} bytes` } };
      }
      return { ok: true, indiceEn: posicion, indiceTam: tam, delante: posicion < total / 2 };
    }

    if (tam < 8 || !Number.isFinite(tam)) {
      return {
        ok: false,
        veredicto: { ok: false, causa: 'fichero roto', detalle: `caja ${tipo} de ${tam} bytes en ${posicion}` },
      };
    }
    posicion += tam;
  }

  return { ok: false, veredicto: noSeSabe('índice no encontrado', `tras ${SALTOS_MAX} cajas`) };
}

const noSeSabe = (causa: string, detalle: string): Arranque =>
  ({ ok: false, causa, detalle, sinVeredicto: true });

/**
 * Recorre el arranque del reproductor y dice si llegaría a haber imagen.
 *
 * Distingue a propósito entre «no se pudo saber» y «no arranca». Lo primero no condena: un origen
 * que hoy va lento puede ir bien mañana, y este proyecto ya aprendió a base de disgustos que
 * enterrar por lentitud vacía el catálogo. Lo que sí condena es lo que no depende del día: un
 * fichero cuyas cajas no cuadran, o un índice que no está donde el propio fichero dice.
 */
export async function puedeAbrirse(url: string): Promise<Arranque> {
  // --- 1. abrir con rango abierto, como media3 ---
  let abierto: Response;
  try {
    abierto = await pedir(url, 0);
  } catch (e: any) {
    return noSeSabe('no contesta', e?.message || String(e));
  }
  if (!abierto.ok || !abierto.body) {
    return noSeSabe(`estado ${abierto.status}`, abierto.statusText || '');
  }

  const total = totalDe(abierto);
  const declarado = Number(abierto.headers.get('content-length') || 0);
  if (!total) {
    await abierto.body.cancel().catch(() => {});
    return noSeSabe('sin tamaño', 'ni Content-Range ni Content-Length');
  }

  /*
   * media3 toma el `Content-Length` como el tamaño del RECURSO: si se le entrega menos que el
   * fichero entero, se cree que la película acaba ahí. Sin error y sin reintento. Esto SÍ condena,
   * porque no depende de la suerte: es cómo se está sirviendo.
   */
  if (declarado > 0 && declarado < total) {
    await abierto.body.cancel().catch(() => {});
    return { ok: false, causa: 'la respuesta se corta', detalle: `declara ${declarado} de ${total} bytes` };
  }

  let cabeceraCorta: Uint8Array;
  try {
    cabeceraCorta = await leerHasta(abierto, 16);
  } catch (e: any) {
    return noSeSabe('la cabecera se corta', e?.message || String(e));
  }
  await abierto.body.cancel().catch(() => {});

  /**
   * ¿ES UN MP4 SIQUIERA? Si no lo es, esta prueba no opina.
   *
   * Todo lo que hay debajo son reglas del formato mp4, y aplicarlas a otro contenedor da basura
   * con pinta de veredicto. Pasó: una película tenía un `.mkv` listado primero, este código leyó
   * sus bytes como si fueran cajas mp4 y concluyó «índice de 440 MB en un fichero de 370» — o sea
   * «fichero roto» sobre una película perfectamente sana, que además tenía su `.mp4` al lado.
   *
   * Y esto decide RETIRADAS. Un Matroska lo reproduce ExoPlayer sin problema; el que no sabe leerlo
   * es este comprobador, y un comprobador que no entiende algo no puede condenarlo.
   */
  const magia = cabeceraCorta.subarray(0, 12);
  const esMp4 = magia.length >= 8 && String.fromCharCode(magia[4], magia[5], magia[6], magia[7]) === 'ftyp';
  if (!esMp4) {
    return noSeSabe('no es un mp4', 'este comprobador solo sabe de mp4');
  }

  // --- 2. ¿dónde está el índice? ---
  const donde = await localizarIndice(url, total);
  if (!donde.ok) return donde.veredicto;
  const { indiceEn, indiceTam, delante } = donde;

  // --- 3. el índice ENTERO, que es lo que separa «abre» de «se queda cargando» ---
  const t0 = Date.now();
  let respuestaIndice: Response;
  try {
    respuestaIndice = await pedir(url, indiceEn, Math.min(indiceEn + indiceTam - 1, total - 1));
  } catch (e: any) {
    return noSeSabe('el índice no llega', `${(indiceTam / 1048576).toFixed(1)} MB: ${e?.message || e}`);
  }
  if (!respuestaIndice.ok || !respuestaIndice.body) {
    return noSeSabe(`el índice da ${respuestaIndice.status}`, `en el byte ${indiceEn}`);
  }

  let leido: Uint8Array;
  try {
    leido = await leerHasta(respuestaIndice, indiceTam);
  } catch (e: any) {
    return noSeSabe('el índice se corta', e?.message || String(e));
  }
  const ms = Date.now() - t0;

  if (leido.length < indiceTam) {
    // Se sirvió MENOS índice del que el propio fichero dice tener. Con el índice a medias no hay
    // duración, ni posición, ni imagen — y esto no es cuestión de esperar más.
    return { ok: false, causa: 'índice incompleto', detalle: `${leido.length} de ${indiceTam} bytes` };
  }

  return {
    ok: true,
    causa: 'arranca',
    detalle: `índice ${delante ? 'delante' : 'al final'} de ${(indiceTam / 1048576).toFixed(1)} MB en ${(ms / 1000).toFixed(1)} s`,
  };
}
