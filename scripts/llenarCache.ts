/**
 * DEJA UNA PELÍCULA ENTERA EN R2, DE UNA PASADA.
 *
 * `calentarIndices.ts` calienta los bordes de todo el catálogo —tres trozos por delante y cuatro
 * por detrás—, que es lo que hace falta cuando el problema del origen es la LATENCIA: el
 * espectador paga una espera al abrir y luego el fichero fluye.
 *
 * Esto es para el otro caso, que se midió el 2026-09-20 sobre `permanent-video-share.lovable.app`
 * y que el calentador de bordes no puede resolver:
 *
 *   una conexión desde el byte 0, 250 MB seguidos ......... 10,8 MB/s
 *   4 MB pedidos en el offset 1,2 GB ....................... 48 s
 *   100 MB pedidos en el offset 1,2 GB .................... 52 s
 *
 * Los mismos 52 s para 4 MB que para 100 MB: el origen no sabe saltar, recorre el fichero desde
 * el principio hasta lo que le pidas. Con eso, pedir trozos sueltos es lo peor que se puede
 * hacer —los del final se pasan del tope de 45 s y fallan—, y leer de corrido es gratis.
 *
 * Así que aquí no se calientan bordes: se llena el fichero ENTERO. Dos minutos y medio de trabajo
 * que nadie mira, y a cambio la app puede saltar por la película como si el host supiera hacerlo.
 *
 *   npx ts-node scripts/llenarCache.ts https://…/inv.mkv
 *
 * Requisito: el dominio tiene que estar encendido en «⚡ Caché por dominio» del panel. Si no lo
 * está, la API no emite url de caché para él y esto lo dice en vez de fallar raro.
 */
import 'dotenv/config';
import { urlApiProduccion } from '../src/config/produccion';

const API = urlApiProduccion('CATALOG_URL');

/**
 * Trozos por llamada, y son 48 —192 MB— por una razón medida.
 *
 * La primera versión pedía 512 de una vez (el tope del Worker) y la invocación murió en el trozo
 * 64, o sea a los ~25 s: Cloudflare no deja que una invocación dure lo que dura este trabajo, por
 * mucho que los bytes fluyan. Cortar por tiempo no rompe nada —lo escrito en R2 se queda— pero
 * deja la llamada sin su resumen.
 *
 * 48 trozos son unos 18 s al ritmo medido (10,8 MB/s), con margen para terminar y contestar. Una
 * película de 1,6 GB son nueve llamadas: el peaje de arrancar en profundidad se paga nueve veces
 * en vez de una, pero se paga entero y sin sustos.
 */
const POR_LLAMADA = 48;

/**
 * La URL firmada de la caché para este fichero, tal y como la emitiría la API al reproductor.
 *
 * Se le PIDE a la API en vez de calcularla aquí, igual que en `calentarIndices.ts`: un proceso
 * que solo llena una caché no tiene por qué poder firmar nada.
 */
async function urlFirmada(urlFichero: string): Promise<string | null> {
  const e = Buffer.from(urlFichero, 'utf8').toString('base64url');
  const r = await fetch(`${API}/api/v1/stream/direct?e=${e}&mode=proxy`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const destino = r.headers.get('location') || '';
  return destino.includes('/v?') ? destino : null;
}

/** Una llamada al Worker. Devuelve la última línea, que es el resumen. */
async function llenarDesde(base: string, desde: number): Promise<any> {
  const url = base.replace('/v?', '/llena?') + `&d=${desde}&n=${POR_LLAMADA}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(900_000) });
  if (!r.ok || !r.body) return { ok: false, motivo: `el Worker contestó ${r.status}` };

  /*
   * Se lee LÍNEA A LÍNEA y se va enseñando. La respuesta gotea a propósito (ver
   * `llenarSecuencial`), y tragársela entera con `.text()` sería quedarse dos minutos mirando una
   * pantalla quieta sin saber si avanza.
   */
  const lector = r.body.getReader();
  const decodificador = new TextDecoder();
  let resto = '';
  let ultima: any = null;
  /*
   * POR DÓNDE IBA CUANDO SE CORTÓ, que es casi tan útil como el resumen.
   *
   * Cloudflare puede cerrar la invocación antes de que termine —pasó a los 25 s, en el trozo 64—,
   * y entonces no llega ninguna línea de resumen. Lo escrito en R2 se queda igual, así que eso no
   * es un fallo: es una pasada a medias. Anotando el último trozo anunciado, la vuelta siguiente
   * sabe dónde retomar y esto se convierte en un trabajo que siempre acaba, solo que por tandas.
   */
  let ultimoVisto = desde;

  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    resto += decodificador.decode(value, { stream: true });
    const lineas = resto.split('\n');
    resto = lineas.pop() || '';
    for (const linea of lineas) {
      if (!linea.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(linea); } catch { continue; }
      if (obj.evento === 'va') { ultimoVisto = obj.trozo; process.stdout.write(`\r   trozo ${obj.trozo}/${obj.de}   `); }
      else if (obj.evento === 'empieza') {
        // También es avance: si la tanda se corta sin dar una sola línea de progreso, saber dónde
        // EMPEZÓ basta para que la siguiente no vuelva a empezar donde ya no hace falta.
        ultimoVisto = Math.max(ultimoVisto, obj.desde);
        console.log(`   empieza en el trozo ${obj.desde} (${obj.yaEstaban} ya estaban)`);
      }
      else ultima = obj;
    }
  }
  process.stdout.write('\n');
  return ultima || { ok: true, parcial: true, guardados: ultimoVisto - desde, yaEstaban: 0, siguiente: ultimoVisto };
}

async function main() {
  const fichero = process.argv[2];
  if (!fichero || !/^https?:\/\//i.test(fichero)) {
    console.error('Uso: npx ts-node scripts/llenarCache.ts <url del fichero>');
    process.exit(1);
  }

  const base = await urlFirmada(fichero);
  if (!base) {
    console.error('La API no emite url de caché para ese fichero.');
    console.error('Enciende su dominio en «⚡ Caché por dominio» del panel y vuelve a intentarlo.');
    process.exit(1);
  }

  console.log(`Llenando la caché de ${fichero}`);
  let desde = 0;
  let enVacio = 0;
  for (let vuelta = 1; vuelta <= 60; vuelta++) {
    const r = await llenarDesde(base, desde);
    if (!r.ok) {
      console.error(`❌ ${r.motivo}`);
      if (typeof r.siguiente === 'number') console.error(`   se quedó en el trozo ${r.siguiente}; vuelve a lanzarlo y sigue desde ahí`);
      process.exit(1);
    }
    console.log(`   guardados ${r.guardados}, ya estaban ${r.yaEstaban}, va por el trozo ${r.siguiente}` +
      (r.trozosDelFichero ? ` de ${r.trozosDelFichero}` : ''));
    if (r.completo) {
      console.log('✅ El fichero entero está en R2. Cualquier salto sale ya de la caché.');
      return;
    }
    /*
     * UNA VUELTA EN VACÍO NO ES EL FINAL, PERO TRES SÍ.
     *
     * Cloudflare corta invocaciones de vez en cuando y a veces lo hace antes de la primera línea
     * de progreso: esa vuelta no avanza nada. Rendirse ahí era tirar un trabajo que iba por el
     * 65%, y encima con todo lo bajado ya guardado en R2. Pero insistir sin límite sobre algo que
     * de verdad no puede avanzar es peor, así que se cuentan: tres seguidas y se para.
     */
    if (typeof r.siguiente !== 'number' || r.siguiente <= desde) {
      enVacio++;
      if (enVacio >= 3) {
        console.error(`❌ Tres vueltas seguidas sin avanzar del trozo ${desde}. Se para aquí.`);
        process.exit(1);
      }
      console.log(`   (vuelta en vacío ${enVacio}/3, se reintenta desde el trozo ${desde})`);
      continue;
    }
    enVacio = 0;
    desde = r.siguiente;
  }
  console.error('Se acabaron las vueltas sin terminar. Vuelve a lanzarlo: sigue donde lo dejó.');
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
