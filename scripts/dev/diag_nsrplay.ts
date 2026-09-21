/**
 * ¿CUÁNTO APORTA NASRIPLAY, Y QUÉ TRAE QUE NO TRAIGA UNLIMPLAY? (2026-09-21)
 *
 * NasriPlay (nsrplay.space) exige API key propia: `NSRPLAY_API_KEY` en .env (la del usuario, sacada
 * en su /dashboard). `GET /api/v1/embed/sources/movie/<tmdb>` da los servidores con su idioma; los
 * que no traen `directUrl` se resuelven con `GET /api/v1/embed/resolve?token=`.
 *
 * Se mide sobre la misma muestra que diag_unlimplay.ts y se cuenta cuántos ficheros son DISTINTOS
 * de los de UnlimPlay (por el id del fichero en la url), porque dos agregadores que sirven los
 * mismos ficheros no son dos fuentes: son una, dos veces.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_nsrplay.ts --muestra=25
 */
import 'dotenv/config';
import axios from 'axios';
import { supabase } from '../../src/services/supabaseService';
import { TMDB_API_KEY } from '../../src/services/tmdbService';

const N = Number(process.argv.find((a) => a.startsWith('--muestra='))?.split('=')[1] || 25);
const KEY = process.env.NSRPLAY_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://nsrplay.space/api/v1/embed';

const esLatino = (l: string) => /latino/i.test(l || '');
/** El id del fichero que comparten los hosts de la familia (…/<id>_n/… o …/<id>_,n,h,…). */
const idFichero = (u: string) => (u.match(/\/([a-z0-9]{12})(?:_|\/|$)/i) || [])[1] || u;

async function nsr(tmdb: number) {
  const r = await axios.get(`${API}/sources/movie/${tmdb}`, { headers: { 'X-API-Key': KEY }, timeout: 60000, validateStatus: () => true });
  return r.status === 200 && r.data?.success ? (r.data.servers || []) as any[] : null;
}

async function resolver(token: string): Promise<string | null> {
  const r = await axios.get(`${API}/resolve`, { params: { token }, headers: { 'X-API-Key': KEY }, timeout: 60000, validateStatus: () => true });
  return r.data?.success ? r.data.data?.directUrl || null : null;
}

async function unlim(tmdb: number): Promise<string[]> {
  const r = await axios.get(`https://unlimplay.com/f/embed/movie/${tmdb}`, { headers: { 'User-Agent': UA }, timeout: 40000, responseType: 'text', validateStatus: () => true });
  const m = String(r.data || '').match(/finalizePlayer\((\{[\s\S]*?\})\)\s*;?\s*\}?\s*<\/script>/);
  if (!m) return [];
  try { return Object.values((JSON.parse(m[1]).latino || {}) as Record<string, string>); } catch { return []; }
}

/** Que el HLS conteste con una playlist: sin esto «resuelto» no dice nada. */
async function hlsVivo(url: string): Promise<boolean> {
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 20000, responseType: 'text', validateStatus: () => true });
    return r.status === 200 && String(r.data).startsWith('#EXTM3U');
  } catch { return false; }
}

async function main() {
  if (!KEY) throw new Error('Falta NSRPLAY_API_KEY en .env');
  const nuestros = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from('media_items').select('tmdb_id').eq('type', 'movie').gt('tmdb_id', 0).order('tmdb_id').range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => nuestros.add(Number(r.tmdb_id)));
    if (!data || data.length < 1000) break;
  }
  const lista = [...nuestros];
  const ya = Array.from({ length: N }, (_, i) => lista[Math.floor((i + 0.5) * lista.length / N)]);
  const pop: number[] = [];
  for (let p = 1; p <= 10; p++) {
    const { data } = await axios.get('https://api.themoviedb.org/3/discover/movie', {
      params: { api_key: TMDB_API_KEY, language: 'es-MX', sort_by: 'popularity.desc', page: p, 'vote_count.gte': 50 }, timeout: 15000,
    });
    pop.push(...(data.results || []).map((r: any) => Number(r.id)));
  }
  const nuevas = pop.filter((id) => !nuestros.has(id)).slice(0, N);

  for (const [nombre, ids] of [['YA tenemos', ya], ['NO tenemos', nuevas]] as const) {
    console.log(`\n── ${nombre} (${ids.length}) ──`);
    let conLatino = 0, conVivo = 0, soloNsr = 0, ficherosNuevos = 0;
    const porServer: Record<string, { vistos: number; vivos: number }> = {};
    for (const id of ids) {
      const servs = await nsr(id).catch(() => null);
      const lat = (servs || []).filter((s) => esLatino(s.language));
      if (lat.length) conLatino++;
      const vivos: string[] = [];
      for (const s of lat) {
        const k = String(s.server || s.name || '?');
        porServer[k] = porServer[k] || { vistos: 0, vivos: 0 };
        porServer[k].vistos++;
        const url = s.directUrl || (s.token ? await resolver(s.token).catch(() => null) : null);
        if (url && await hlsVivo(url)) { porServer[k].vivos++; vivos.push(url); }
      }
      if (vivos.length) conVivo++;
      const deUnlim = new Set((await unlim(id).catch(() => [])).map(idFichero));
      const distintos = vivos.filter((u) => !deUnlim.has(idFichero(u)));
      if (distintos.length) ficherosNuevos++;
      if (vivos.length && !deUnlim.size) soloNsr++;
      console.log(`  ${String(id).padStart(7)}  latino: ${lat.map((s) => s.server).join(',') || '—'}  vivos ${vivos.length}  distintos de UnlimPlay ${distintos.length}${!deUnlim.size && vivos.length ? '  (UnlimPlay no la tiene)' : ''}`);
    }
    console.log(`  → latino ${conLatino}/${ids.length} · con HLS vivo ${conVivo} · con ficheros que UnlimPlay no da ${ficherosNuevos} · títulos que solo tiene NasriPlay ${soloNsr}`);
    console.log(`  servidores latino (vistos → HLS vivo): ${Object.entries(porServer).map(([k, v]) => `${k} ${v.vistos}→${v.vivos}`).join(' · ')}`);
  }
}

main().catch((e) => { console.error(e?.response?.data || e); process.exit(1); });
