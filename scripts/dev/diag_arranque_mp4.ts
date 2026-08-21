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
import { puedeAbrirse } from '../../src/services/arranqueMp4';

/**
 * La dirección pública de la API. La url firmada se le PIDE a ella en vez de calcularla aquí.
 *
 * Calcularla exige la clave de firma, y esa clave no está —ni tiene por qué estar— en la máquina
 * de quien diagnostica: Vercel la devuelve censurada a propósito. Firmando con una clave
 * equivocada, el Worker contesta 403 y el diagnóstico entero sale «0 de 15» por un motivo que no
 * tiene nada que ver con las películas. Pedirla es una petición más y quita la clave de en medio.
 */
const API = process.env.CATALOG_URL || 'https://api-pelis-series-latino-gilt.vercel.app';

/** La url tal y como la recibiría la app, firmada por quien sabe firmar. */
async function comoLaVeLaApp(urlGuardada: string): Promise<string> {
  try {
    const e = Buffer.from(urlGuardada, 'utf8').toString('base64url');
    const r = await fetch(`${API}/api/v1/stream/direct?e=${e}&mode=proxy`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const destino = r.headers.get('location') || '';
    return destino.startsWith('http') ? destino : urlGuardada;
  } catch {
    return urlGuardada;
  }
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

/**
 * La prueba vive en `src/services/arranqueMp4.ts` y NO se copia aquí.
 *
 * Estaba duplicada, y duplicada no sirve para lo que existe: si el verificador retira por una
 * regla y el diagnóstico mide por otra, el número que sale aquí deja de decir nada sobre lo que
 * va a pasar en la app. Este script es la MISMA pregunta, hecha a todo el catálogo de golpe y con
 * un resumen por causa.
 */
async function probar(id: string, titulo: string, url: string): Promise<Veredicto> {
  const r = await puedeAbrirse(url);
  return { id, titulo, ok: r.ok, causa: r.sinVeredicto ? `${r.causa} (sin veredicto)` : r.causa, detalle: r.detalle };
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
    // La MISMA url que recibiría la app, no la guardada. Ver la nota en `verificarPermanentes`.
    const v = await probar(fila.id, fila.title, await comoLaVeLaApp(conVideo.direct_stream))
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
