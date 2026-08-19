import 'dotenv/config';
import axios from 'axios';
import { streamClient } from '../../src/utils/httpClient';

/**
 * ¿REPRODUCE DE VERDAD LO QUE SE ANUNCIA? — la prueba definitiva, por el camino del espectador.
 *
 * `diag_fantasmas_api.ts` mide si la API DEVUELVE servidores. No es lo mismo que reproducir: un
 * servidor entregado puede contestar 502 al pedirle el vídeo, que es justo lo que le pasaba al
 * usuario. Aquí se baja hasta el SEGMENTO, igual que ExoPlayer: enlace → maestro → variante →
 * bytes de vídeo.
 *
 * Y SE DISTINGUE PELÍCULA DE SERIE, que la primera versión de esto no hacía y por eso mentía. Una
 * serie NO tiene servidores a nivel de ficha —se reproduce por capítulo—, así que pedirle
 * `/media/:id/streams` devuelve una lista vacía correctísima. Contarlo como fallo daba tres
 * «errores» que no lo eran. A una serie se le pide su ficha y se prueba el primer capítulo
 * anunciable, que es lo que haría alguien al abrirla.
 *
 *   npx ts-node scripts/dev/diag_reproduccion.ts
 *   npx ts-node scripts/dev/diag_reproduccion.ts https://otro-host 20
 */

const API = (process.argv[2] || 'https://api-pelis-series-latino-gilt.vercel.app').replace(/\/+$/, '');
const CUANTOS = Number(process.argv[3]) || 14;

/** Sigue la cadena hasta los bytes de vídeo. Devuelve el rastro para poder leer dónde se rompió. */
async function reproducir(url: string): Promise<{ ok: boolean; rastro: string }> {
  const pasos: string[] = [];
  let u = url;
  for (let salto = 0; salto < 3; salto++) {
    const r = await streamClient.get(u, {
      headers: { Range: 'bytes=0-65535' },
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 45000,
      validateStatus: () => true,
    });
    const buf = Buffer.from((r.data as any) || []);
    pasos.push(`${r.status}/${buf.length}B`);
    if (r.status !== 200 && r.status !== 206) return { ok: false, rastro: pasos.join('→') };
    if (!buf.slice(0, 16).toString('utf8').startsWith('#EXTM3U')) {
      return { ok: buf.length > 2048, rastro: pasos.join('→') };
    }
    const sig = buf.toString('utf8').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!sig) return { ok: false, rastro: pasos.join('→') + '/lista-vacía' };
    u = /^https?:\/\//i.test(sig) ? sig : API + (sig.startsWith('/') ? '' : '/') + sig;
  }
  return { ok: false, rastro: pasos.join('→') + '/sin-vídeo' };
}

/** El primer enlace que el espectador probaría de este título. */
async function primerEnlace(item: any): Promise<{ url?: string; nota: string }> {
  if (item.type === 'tvseries') {
    const ficha = (await axios.get(`${API}/api/v1/media/${encodeURIComponent(item.id)}`, { timeout: 90000 })).data.data;
    for (const t of ficha.seasons || []) {
      for (const e of t.episodes || []) {
        const s = (e.servers || [])[0];
        if (s?.direct_stream) return { url: s.direct_stream, nota: `T${t.season_number}E${e.episode_number}` };
      }
    }
    return { nota: 'sin capítulos anunciables' };
  }
  const d = (await axios.get(`${API}/api/v1/media/${encodeURIComponent(item.id)}/streams`, { timeout: 90000 })).data.data;
  const s = (d.servers || [])[0];
  return s?.direct_stream ? { url: s.direct_stream, nota: `${(d.servers || []).length} srv` } : { nota: 'sin servidores' };
}

(async () => {
  console.log(`BASE = ${API}\n`);
  const home = (await axios.get(`${API}/api/v1/home?limit=20`, { timeout: 90000 })).data.data;
  const candidatos: any[] = [];
  for (const fila of home.rows || []) for (const it of (fila.items || []).slice(0, 4)) candidatos.push(it);

  const vistos = new Set<string>();
  let ok = 0, mal = 0;
  for (const it of candidatos) {
    if (vistos.has(it.id) || vistos.size >= CUANTOS) continue;
    vistos.add(it.id);
    const etiqueta = `${(it.type === 'tvseries' ? '[serie] ' : '[peli]  ')}${String(it.title).slice(0, 32).padEnd(33)}`;
    try {
      const { url, nota } = await primerEnlace(it);
      if (!url) { mal++; console.log(`✗ ${etiqueta} ${nota}`); continue; }
      const r = await reproducir(url);
      r.ok ? ok++ : mal++;
      console.log(`${r.ok ? '✓' : '✗'} ${etiqueta} ${nota} · ${r.rastro}`);
    } catch (e: any) {
      mal++;
      console.log(`✗ ${etiqueta} ${e.message}`);
    }
  }
  const total = ok + mal;
  console.log(`\nREPRODUCEN ${ok}/${total}  (${((ok / Math.max(1, total)) * 100).toFixed(0)}%)`);
})();
