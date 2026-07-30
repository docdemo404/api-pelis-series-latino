/**
 * ¿DÓNDE se va el tiempo? Mide la API como la vive un cliente: en frío y en caliente.
 *
 * Antes de optimizar nada hay que saber qué es lento, porque la intuición falla: en este
 * proyecto ya pasó que se dio por caro el scraping cuando lo caro era una comprobación de salud
 * metida en el camino de la respuesta.
 *
 * FRÍO es lo que sufre el primero que abre una ficha (caché vacío); CALIENTE es lo que ve el
 * resto. Los dos importan y por motivos distintos: el frío es la peor experiencia real, el
 * caliente es el suelo al que se puede aspirar.
 *
 *   npx ts-node --transpile-only scripts/dev/bench_api.ts [--base=https://…] [--vueltas=3]
 */
import 'dotenv/config';
import { httpClient } from '../../src/utils/httpClient';

const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const BASE = arg('base', 'https://api-pelis-series-latino-gilt.vercel.app');
const VUELTAS = Number(arg('vueltas', '3'));

interface Medida { nombre: string; frio: number; caliente: number[]; bytes: number; estado: number }

async function pedir(url: string): Promise<{ ms: number; bytes: number; estado: number }> {
  const t0 = Date.now();
  try {
    const r = await httpClient.get(url, {
      timeout: 60000,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
      headers: { 'Cache-Control': 'no-cache' },
    });
    return { ms: Date.now() - t0, bytes: String(r.data || '').length, estado: r.status };
  } catch (e: any) {
    return { ms: Date.now() - t0, bytes: 0, estado: 0 };
  }
}

(async () => {
  // `?_=` rompe el caché de borde para medir el frío de verdad; sin él se mide la CDN de Vercel.
  const sello = () => `_=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

  const casos: Array<{ nombre: string; url: (frio: boolean) => string }> = [
    { nombre: 'home',              url: f => `${BASE}/api/v1/home${f ? `?${sello()}` : ''}` },
    { nombre: 'búsqueda',          url: f => `${BASE}/api/v1/search?q=batman&limit=20${f ? `&${sello()}` : ''}` },
    { nombre: 'ficha (película)',  url: f => `${BASE}/api/v1/media/undefeatable${f ? `?${sello()}` : ''}` },
    { nombre: 'ficha (serie)',     url: f => `${BASE}/api/v1/media/fc-invencible${f ? `?${sello()}` : ''}` },
    { nombre: 'episodio',          url: f => `${BASE}/api/v1/series/4-ever/season/1/episode/1${f ? `?${sello()}` : ''}` },
  ];

  const medidas: Medida[] = [];
  for (const caso of casos) {
    const frio = await pedir(caso.url(true));
    const caliente: number[] = [];
    for (let i = 0; i < VUELTAS; i++) caliente.push((await pedir(caso.url(false))).ms);
    medidas.push({ nombre: caso.nombre, frio: frio.ms, caliente, bytes: frio.bytes, estado: frio.estado });
  }

  console.log(`\n${BASE}\n`);
  console.log('endpoint              en frío     en caliente (mediana)   tamaño');
  for (const m of medidas) {
    const orden = [...m.caliente].sort((a, b) => a - b);
    const mediana = orden[Math.floor(orden.length / 2)];
    const kb = (m.bytes / 1024).toFixed(0);
    console.log(
      `${m.nombre.padEnd(20)} ${String(m.frio + ' ms').padStart(9)}   ${String(mediana + ' ms').padStart(12)}` +
      `            ${kb.padStart(5)} KB${m.estado !== 200 ? `   (HTTP ${m.estado})` : ''}`
    );
  }
})();
