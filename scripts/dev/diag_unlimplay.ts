/**
 * ¿CUÁNTO APORTA UNLIMPLAY? (2026-09-21)
 *
 * UnlimPlay es un agregador por tmdb_id: `https://unlimplay.com/f/embed/movie/<tmdb>` devuelve una
 * página cuyo `finalizePlayer({...})` trae los servidores ya resueltos por idioma
 * (`latino` / `español` / `subtitulado` → host → url). Se mide, antes de escribir nada:
 *
 *   1. De películas que YA tenemos: ¿cuántas trae y con qué hosts? (aporte = servidores de más)
 *   2. De películas que NO tenemos (populares en TMDB es-MX): ¿cuántas trae en latino? (fichas nuevas)
 *   3. ¿Sale vídeo? Se pasa cada embed por `extractDirect`, el mismo embudo que usa el catálogo,
 *      que ya descarta señuelos (voe, doodstream) y vídeos de muestra.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_unlimplay.ts --muestra=30
 */
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';
import { TMDB_API_KEY } from '../../src/services/tmdbService';
import { extractDirect, esVideoDeMuestra } from '../../src/scrapers/directStream';

const N = Number(process.argv.find((a) => a.startsWith('--muestra='))?.split('=')[1] || 30);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
type Servidores = Record<string, Record<string, string>>;

/** Los servidores de una película según UnlimPlay, o null si la página no los trae. */
async function servidores(tmdb: number): Promise<Servidores | null> {
  const r = await axios.get(`https://unlimplay.com/f/embed/movie/${tmdb}`, {
    headers: { 'User-Agent': UA }, timeout: 40000, responseType: 'text', validateStatus: () => true,
  });
  if (r.status !== 200) return null;
  const m = String(r.data).match(/finalizePlayer\((\{[\s\S]*?\})\)\s*;?\s*\}?\s*<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function idsNuestros(n: number): Promise<Set<number>> {
  const out = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from('media_items').select('tmdb_id').eq('type', 'movie')
      .gt('tmdb_id', 0).order('tmdb_id').range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.add(Number(r.tmdb_id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function populares(paginas: number): Promise<number[]> {
  const ids: number[] = [];
  for (let p = 1; p <= paginas; p++) {
    const { data } = await axios.get('https://api.themoviedb.org/3/discover/movie', {
      params: { api_key: TMDB_API_KEY, language: 'es-MX', sort_by: 'popularity.desc', page: p, 'vote_count.gte': 50 },
      timeout: 15000,
    });
    ids.push(...(data.results || []).map((r: any) => Number(r.id)));
  }
  return ids;
}

const hostDe = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return '?'; } };

async function medir(nombre: string, ids: number[]) {
  console.log(`\n── ${nombre} (${ids.length}) ──`);
  let conAlgo = 0, conLatino = 0, conVideoLatino = 0;
  const hosts: Record<string, { vistos: number; video: number }> = {};
  for (const id of ids) {
    let s: Servidores | null = null;
    try { s = await servidores(id); } catch { /* red */ }
    const idiomas = s ? Object.keys(s).filter((k) => Object.keys(s![k] || {}).length) : [];
    if (idiomas.length) conAlgo++;
    const latino = s?.latino || {};
    if (Object.keys(latino).length) conLatino++;
    let algunVideo = false;
    for (const [prov, url] of Object.entries(latino)) {
      if (prov === 'proxy' || !/^https?:/.test(url)) continue;
      const h = prov === 'direct' ? `direct:${hostDe(url)}` : hostDe(url);
      hosts[h] = hosts[h] || { vistos: 0, video: 0 };
      hosts[h].vistos++;
      let ok = false;
      if (prov === 'direct') {
        ok = /\.m3u8/.test(url);
      } else {
        try {
          const html = (await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://unlimplay.com/' }, timeout: 20000, responseType: 'text', validateStatus: () => true })).data;
          const d = await extractDirect(url, String(html || ''), { allowNetwork: true });
          ok = !!d?.url && !esVideoDeMuestra(d.url);
        } catch { /* no sale */ }
      }
      if (ok) { hosts[h].video++; algunVideo = true; }
    }
    if (algunVideo) conVideoLatino++;
    console.log(`  ${String(id).padStart(7)}  idiomas [${idiomas.join(',') || '—'}]  latino: ${Object.keys(latino).filter((k) => k !== 'proxy').join(',') || '—'}${algunVideo ? '  ✔ vídeo' : ''}`);
  }
  console.log(`  → con algo ${conAlgo}/${ids.length} · con latino ${conLatino} · latino con vídeo extraíble ${conVideoLatino}`);
  console.log(`  hosts latino (vistos → con vídeo): ${Object.entries(hosts).sort((a, b) => b[1].vistos - a[1].vistos).map(([h, v]) => `${h} ${v.vistos}→${v.video}`).join(' · ')}`);
}

async function main() {
  const nuestros = await idsNuestros(N);
  const lista = [...nuestros];
  const muestraNuestra = Array.from({ length: N }, (_, i) => lista[Math.floor((i + 0.5) * lista.length / N)]);
  const pop = await populares(10);
  const nuevas = pop.filter((id) => !nuestros.has(id)).slice(0, N);
  console.log(`catálogo: ${nuestros.size} películas · populares TMDB mirados: ${pop.length} · de ellos NO tenemos: ${pop.filter((id) => !nuestros.has(id)).length}`);
  await medir('Películas que YA tenemos', muestraNuestra);
  await medir('Populares que NO tenemos', nuevas);
}

main().catch((e) => { console.error(e); process.exit(1); });
