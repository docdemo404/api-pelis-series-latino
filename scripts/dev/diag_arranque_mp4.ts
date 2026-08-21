/**
 * ¿ARRANCARÍA ESTA PELÍCULA EN EL REPRODUCTOR? Se pregunta igual que lo pregunta media3.
 *
 * Existe porque estuve arreglando títulos DE UNO EN UNO, y eso no es arreglar nada: cada película
 * de archive.org fallaba por un motivo distinto —el corte a 4 MB de la caché, un índice de 7,5 MB,
 * un índice colocado al final, un tamaño mal anotado— y cada arreglo dejaba las demás igual de
 * rotas. Sin una medida sobre TODO el catálogo no hay forma de saber si una causa está resuelta o
 * solo se movió de sitio.
 *
 * Lo que hace, por cada servidor, es exactamente la secuencia del reproductor:
 *
 *   1. Pide `bytes=0-` sin final, como hace media3 al abrir. Comprueba que la respuesta declare el
 *      fichero ENTERO: si el `Content-Length` dice menos, media3 se cree que la película acaba ahí.
 *   2. Lee la cabecera y localiza el `moov`, que es el índice. Puede estar delante o detrás del
 *      vídeo, y esa diferencia decide si hay un salto de cientos de megas antes del primer
 *      fotograma.
 *   3. Descarga el índice ENTERO desde donde esté, cronometrando. Es el paso que de verdad separa
 *      «abre» de «se queda cargando»: sin índice completo no hay duración, ni posición, ni imagen.
 *   4. Pide un trozo del medio, que es lo que pasa al adelantar.
 *
 * Un veredicto por película y un resumen por CAUSA al final. Lo que se busca en ese resumen no es
 * cuántas fallan: es si todas las que fallan lo hacen por lo mismo.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/** Lo que media3 aguanta antes de dar una fuente por perdida. Ver `ARRANQUE_MS` en la app. */
const PACIENCIA_MS = 25_000;

/** Cajas mp4 de primer nivel que se leen para orientarse. */
interface Caja {
  tipo: string;
  inicio: number;
  tam: number;
}

interface Veredicto {
  id: string;
  titulo: string;
  ok: boolean;
  causa: string;
  detalle: string;
}

// El mismo cliente que usa el verificador: la dirección y la clave viven ahí, no en este script.
const db = getSupabaseAdmin;

/** Pide un tramo y devuelve cabeceras y cuerpo. Sin `hasta`, pide abierto como media3. */
async function pedir(url: string, desde: number, hasta?: number) {
  const rango = hasta === undefined ? `bytes=${desde}-` : `bytes=${desde}-${hasta}`;
  const t0 = Date.now();
  const r = await fetch(url, {
    headers: { Range: rango },
    signal: AbortSignal.timeout(PACIENCIA_MS),
  });
  return { r, ms: Date.now() - t0 };
}

/** Lee como mucho `tope` bytes del cuerpo y corta; devuelve lo leído y si llegó al final. */
async function leerHasta(r: Response, tope: number): Promise<{ datos: Uint8Array; fin: boolean }> {
  const lector = r.body!.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) {
      const junto = new Uint8Array(total);
      let o = 0;
      for (const p of partes) { junto.set(p, o); o += p.length; }
      return { datos: junto, fin: true };
    }
    partes.push(value);
    total += value.length;
    if (total >= tope) {
      await lector.cancel().catch(() => {});
      const junto = new Uint8Array(total);
      let o = 0;
      for (const p of partes) { junto.set(p, o); o += p.length; }
      return { datos: junto, fin: false };
    }
  }
}

/** Las cajas de primer nivel que se ven en este trozo del principio. */
function cajas(d: Uint8Array): Caja[] {
  const vista = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const fuera: Caja[] = [];
  let i = 0;
  while (i + 8 <= d.length && fuera.length < 8) {
    const tam = vista.getUint32(i);
    const tipo = String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
    if (tam < 8) break;
    fuera.push({ tipo, inicio: i, tam });
    i += tam;
  }
  return fuera;
}

/** El total que declara un `Content-Range`, o 0. */
function totalDe(r: Response): number {
  const cr = r.headers.get('content-range') || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  if (m) return Number(m[1]);
  const cl = Number(r.headers.get('content-length'));
  return Number.isFinite(cl) && cl > 0 ? cl : 0;
}

async function probar(id: string, titulo: string, url: string): Promise<Veredicto> {
  const no = (causa: string, detalle: string): Veredicto => ({ id, titulo, ok: false, causa, detalle });

  // --- 1. abrir como media3: rango abierto ---
  let abierto;
  try {
    abierto = await pedir(url, 0);
  } catch (e: any) {
    return no('no contesta', e.message || String(e));
  }
  if (!abierto.r.ok || !abierto.r.body) return no('estado ' + abierto.r.status, abierto.r.statusText);

  const total = totalDe(abierto.r);
  const declarado = Number(abierto.r.headers.get('content-length') || 0);
  if (!total) return no('sin tamaño', 'ni Content-Range ni Content-Length');

  /*
   * ESTA ES LA COMPROBACIÓN QUE HABRÍA AHORRADO DÍAS. media3 toma el `Content-Length` como el
   * tamaño del RECURSO: si se le entrega menos que el fichero entero, se cree que la película
   * termina ahí. Sin error, sin reintento — de ahí venían los títulos que "reproducían diez
   * segundos".
   */
  if (declarado > 0 && declarado < total) {
    await abierto.r.body.cancel().catch(() => {});
    return no('la respuesta se corta', `declara ${declarado} de ${total} bytes`);
  }

  // --- 2. la cabecera, para saber dónde está el índice ---
  const cabecera = await leerHasta(abierto.r, 512 * 1024);
  const vistas = cajas(cabecera.datos);
  if (!vistas.length) return no('no parece mp4', 'no se leyó ninguna caja');

  const moovDelante = vistas.find(c => c.tipo === 'moov');
  let moovEn: number;
  let moovTam: number;

  if (moovDelante) {
    moovEn = moovDelante.inicio;
    moovTam = moovDelante.tam;
  } else {
    // Índice al final: empieza donde acaba la última caja que sí se vio.
    const ultima = vistas[vistas.length - 1];
    moovEn = ultima.inicio + ultima.tam;
    moovTam = total - moovEn;
    if (moovEn >= total) return no('índice ilocalizable', `la última caja acaba en ${moovEn} de ${total}`);
  }

  // --- 3. el índice ENTERO, cronometrado ---
  const t0 = Date.now();
  let indice;
  try {
    indice = await pedir(url, moovEn, Math.min(moovEn + moovTam - 1, total - 1));
  } catch (e: any) {
    return no('el índice no llega', `${moovDelante ? 'delante' : 'al final'}, ${(moovTam / 1048576).toFixed(1)} MB: ${e.message}`);
  }
  if (!indice.r.ok || !indice.r.body) return no('el índice da ' + indice.r.status, `en el byte ${moovEn}`);

  let leido;
  try {
    leido = await leerHasta(indice.r, moovTam);
  } catch (e: any) {
    return no('el índice se corta', e.message || String(e));
  }
  const msIndice = Date.now() - t0;

  if (leido.datos.length < moovTam) {
    return no('índice incompleto', `${leido.datos.length} de ${moovTam} bytes`);
  }
  if (msIndice > PACIENCIA_MS) {
    return no('índice demasiado lento', `${(msIndice / 1000).toFixed(1)} s para ${(moovTam / 1048576).toFixed(1)} MB`);
  }

  // --- 4. un salto al medio, que es adelantar ---
  const medio = Math.floor(total / 2);
  try {
    const salto = await pedir(url, medio, medio + 262143);
    if (!salto.r.ok) return no('no deja adelantar', 'estado ' + salto.r.status);
    await salto.r.body?.cancel().catch(() => {});
    return {
      id, titulo, ok: true,
      causa: 'arranca',
      detalle: `índice ${moovDelante ? 'delante' : 'al final'} de ${(moovTam / 1048576).toFixed(1)} MB en ${(msIndice / 1000).toFixed(1)} s; salto ${(salto.ms / 1000).toFixed(1)} s`,
    };
  } catch (e: any) {
    return no('no deja adelantar', e.message || String(e));
  }
}

async function main() {
  const soloUno = process.argv.find(a => a.startsWith('--id='))?.slice(5);
  const cliente = db();

  const { data, error } = await cliente
    .from('media_items')
    .select('id, title, servers')
    .limit(3000);
  if (error) throw error;

  const objetivo = (data || []).filter(fila => {
    if (soloUno) return fila.id === soloUno;
    const s = JSON.stringify(fila.servers || []);
    return s.includes('archive.org');
  });

  console.log(`Se prueban ${objetivo.length} fichas con vídeo de archive.org.\n`);

  const veredictos: Veredicto[] = [];
  for (const fila of objetivo) {
    const servidores = (fila.servers as any[]) || [];
    const conVideo = servidores.find(s => String(s.direct_stream || '').startsWith('http'));
    if (!conVideo) {
      veredictos.push({ id: fila.id, titulo: fila.title, ok: false, causa: 'sin url', detalle: 'ningún servidor con direct_stream' });
      continue;
    }
    // Envuelto: un tope agotado en cualquier punto es un dato más, no una razón para tirar la
    // medición entera y quedarse sin el resumen — que es lo único que sirve para decidir.
    const v = await probar(fila.id, fila.title, conVideo.direct_stream)
      .catch((e: any) => ({ id: fila.id, titulo: fila.title, ok: false, causa: 'se cortó la prueba', detalle: e.message || String(e) }));
    veredictos.push(v);
    console.log(`${v.ok ? 'OK  ' : 'NO  '} ${v.titulo.slice(0, 40).padEnd(40)} ${v.causa} — ${v.detalle}`);
  }

  const porCausa = new Map<string, number>();
  for (const v of veredictos) {
    if (v.ok) continue;
    porCausa.set(v.causa, (porCausa.get(v.causa) || 0) + 1);
  }

  const buenas = veredictos.filter(v => v.ok).length;
  console.log(`\nArrancan ${buenas} de ${veredictos.length}.`);
  if (porCausa.size) {
    console.log('\nPor qué fallan las demás:');
    for (const [causa, n] of [...porCausa.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${causa}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
