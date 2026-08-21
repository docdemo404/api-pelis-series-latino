/**
 * DEJA EL ÍNDICE DE CADA PELÍCULA EN LA CACHÉ ANTES DE QUE NADIE LA ABRA.
 *
 * Es la pieza que convierte un montón de arreglos sueltos en una solución: hasta ahora, por muy
 * rápida que fuera la caché, alguien pagaba el arranque en frío — el PRIMERO que abría cada
 * película. Y con archive.org ese primero muchas veces no llegaba a verla: se midió sobre las 21
 * fichas del catálogo que salen de ahí y seis fallaban por lo mismo, que traer el índice tardaba
 * más de los 25 segundos que el reproductor aguanta.
 *
 * Un mp4 no se puede abrir sin su índice. Puede ir delante del vídeo o detrás —y en archive.org
 * suele ir detrás—, así que lo primero que hace el reproductor es un salto de cientos de megas.
 * Ese salto, contra un origen que cobra entre 10 y 25 s por petición, es lo que se veía como «se
 * queda cargando y no arranca».
 *
 * Ese trabajo no tiene por qué hacerlo un espectador. Aquí no hay prisa, no hay nadie mirando una
 * pantalla, y se puede tardar lo que haga falta.
 *
 * Corre sobre lo que el catálogo publica como url permanente y le pide al Worker que se traiga los
 * primeros trozos y los últimos. Es idempotente: lo que ya está en R2 no se vuelve a pedir, así
 * que repetirlo cada pocos minutos cuesta casi nada.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { esUrlDeFicheroPermanente } from '../src/scrapers/directStream';

/**
 * La dirección pública de la API. La URL firmada del Worker se le PIDE a ella en vez de calcularla
 * aquí, y eso no es un rodeo: es lo que hace que este script no necesite la clave de firma. Un
 * proceso que solo calienta una caché no tiene por qué poder firmar nada.
 */
const API = process.env.CATALOG_URL || 'https://api-pelis-series-latino-gilt.vercel.app';

/** La URL firmada de la caché para este fichero, tal y como la emitiría la API al reproductor. */
async function urlFirmada(urlFichero: string): Promise<string | null> {
  const e = Buffer.from(urlFichero, 'utf8').toString('base64url');
  const r = await fetch(`${API}/api/v1/stream/direct?e=${e}&mode=proxy`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const destino = r.headers.get('location') || '';
  return destino.includes('/v?') ? destino : null;
}

/**
 * Cuántas películas se calientan a la vez.
 *
 * Bajo a propósito. Cada una son siete peticiones a un origen lento, y lo que cancela las tandas
 * en GitHub no es el tiempo total sino la RÁFAGA de conexiones — ya costó una tanda entera
 * aprenderlo. Aquí no hay ninguna prisa: lo que importa es terminar, no terminar rápido.
 */
const A_LA_VEZ = 3;

/** Tope por película. Calentar siete trozos de archive.org puede pasar del minuto. */
const TOPE_MS = 120_000;

interface Resultado {
  titulo: string;
  ok: boolean;
  detalle: string;
}

async function calentarUna(titulo: string, urlFichero: string): Promise<Resultado> {
  let enLaCache: string | null = null;
  try {
    enLaCache = await urlFirmada(urlFichero);
  } catch (e: any) {
    return { titulo, ok: false, detalle: 'la API no firmó: ' + (e.message || e) };
  }
  if (!enLaCache) return { titulo, ok: false, detalle: 'la API no lo manda por la caché' };

  // La firma cubre solo el parámetro `e`, así que cambiar de ruta no la invalida.
  const url = enLaCache.replace('/v?', '/calienta?');
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TOPE_MS) });
    const cuerpo: any = await r.json().catch(() => ({}));
    if (!r.ok) return { titulo, ok: false, detalle: cuerpo.motivo || `estado ${r.status}` };
    return {
      titulo,
      ok: true,
      detalle: `${cuerpo.traidos} traídos, ${cuerpo.yaEstaban} ya estaban`,
    };
  } catch (e: any) {
    return { titulo, ok: false, detalle: e.message || String(e) };
  }
}

/** La url de fichero de una ficha, si la tiene. Se prefiere la primera que sea permanente. */
function ficheroDe(servidores: any[]): string | null {
  for (const s of servidores || []) {
    for (const campo of [s.direct_stream, s.embed_url]) {
      const u = String(campo || '');
      if (u.startsWith('http') && esUrlDeFicheroPermanente(u)) return u;
    }
  }
  return null;
}

async function main() {
  const soloFuente = process.argv.find(a => a.startsWith('--solo='))?.slice(7);
  const limite = Number(process.argv.find(a => a.startsWith('--limite='))?.slice(9)) || 0;

  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from('media_items')
    .select('id, title, servers')
    .not('servers', 'is', null)
    .limit(3000);
  if (error) throw error;

  const tareas: Array<{ titulo: string; url: string }> = [];
  for (const fila of data || []) {
    const url = ficheroDe(fila.servers as any[]);
    if (!url) continue;
    if (soloFuente && !url.includes(soloFuente)) continue;
    tareas.push({ titulo: String(fila.title || fila.id), url });
    if (limite && tareas.length >= limite) break;
  }

  console.log(`Se calientan ${tareas.length} películas, de ${A_LA_VEZ} en ${A_LA_VEZ}.\n`);

  const resultados: Resultado[] = [];
  for (let i = 0; i < tareas.length; i += A_LA_VEZ) {
    const tanda = tareas.slice(i, i + A_LA_VEZ);
    const hechos = await Promise.all(tanda.map(t => calentarUna(t.titulo, t.url)));
    for (const r of hechos) {
      resultados.push(r);
      console.log(`${r.ok ? 'OK  ' : 'NO  '} ${r.titulo.slice(0, 42).padEnd(42)} ${r.detalle}`);
    }
  }

  const buenas = resultados.filter(r => r.ok).length;
  console.log(`\nÍndice caliente en ${buenas} de ${resultados.length}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
