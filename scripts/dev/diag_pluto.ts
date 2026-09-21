/**
 * ¿CUÁNTO APORTA PLUTO TV DE VERDAD? (2026-09-21)
 *
 * Medición ANTES de cualquier importador, con las mismas preguntas que decidieron hfpro:
 *
 *   1. ¿Cuánto hay en su catálogo bajo demanda (región según la IP que pregunta)?
 *   2. ¿Cuánto sabemos IDENTIFICAR? Pluto no da tmdb_id, así que nada se adopta por título:
 *      se exige año ±1 Y director coincidente (y duración cercana si TMDB la tiene). Un segundo
 *      candidato que también pase = ambigua, se descarta.
 *   3. De lo identificado, ¿cuánto NO tenemos ya?
 *   4. ¿Reproduce, y en qué idioma de audio?
 *
 * Límites a propósito: el stream lo pide el DISPOSITIVO (el JWT lleva su IP), los anuncios van
 * dentro y se quedan, y aquí no se baja ninguna clave ni segmento entero: solo se comprueba que
 * el reproductor los tendría (código HTTP).
 *
 *   npx ts-node --transpile-only scripts/dev/diag_pluto.ts
 *   npx ts-node --transpile-only scripts/dev/diag_pluto.ts --reproducir=30 --limite=300
 */
import 'dotenv/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { supabase } from '../../src/services/supabaseService';
import { TMDB_API_KEY } from '../../src/services/tmdbService';

const arg = (n: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] || d);
const N_REPRO = arg('reproducir', 20);
const LIMITE = arg('limite', 0); // 0 = todas las películas

interface Boot { sessionToken: string; stitcherParams: string; servers: { stitcher: string; vod: string }; session: any }
interface PeliPluto { id: string; nombre: string; anio?: number; minutos?: number; directores: string[]; hls?: string; genero?: string }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function arrancar(): Promise<Boot> {
  const cid = randomUUID();
  const { data } = await axios.get('https://boot.pluto.tv/v4/start', {
    params: {
      appName: 'web', appVersion: '9.0.0', deviceVersion: '120.0.0', deviceModel: 'web', deviceMake: 'chrome',
      deviceType: 'web', clientID: cid, clientModelNumber: '1.0.0', serverSideAds: 'false',
    },
    timeout: 15000,
  });
  return data;
}

async function catalogo(boot: Boot) {
  const { data } = await axios.get(`${boot.servers.vod}/v4/vod/categories`, {
    params: { includeItems: true, offset: 1000, page: 1 },
    headers: { Authorization: `Bearer ${boot.sessionToken}` },
    timeout: 60000,
  });
  const items = new Map<string, any>();
  for (const cat of data.categories || []) for (const it of cat.items || []) items.set(it._id, it);
  return { categorias: (data.categories || []).length, items: [...items.values()] };
}

function aPeli(it: any): PeliPluto {
  const f = it.clip?.originalReleaseDate;
  const ms = it.originalContentDuration || 0;
  return {
    id: it._id,
    nombre: it.name,
    anio: f ? Number(String(f).slice(0, 4)) || undefined : undefined,
    minutos: ms ? Math.round(ms / 60000) : undefined,
    directores: (it.clip?.directors || []).map(norm).filter(Boolean),
    // El catálogo solo trae `stitched` si el boot declaró DRM; la ruta es fija por id.
    hls: it.stitched?.paths?.find((p: any) => p.type === 'hls')?.path || `/stitch/hls/episode/${it._id}/master.m3u8`,
    genero: it.genre,
  };
}

const tmdb = (ruta: string, params: any = {}) =>
  axios.get(`https://api.themoviedb.org/3${ruta}`, { params: { api_key: TMDB_API_KEY, ...params }, timeout: 12000 })
    .then((r) => r.data);

type Veredicto = { tipo: 'verificada'; tmdbId: number } | { tipo: 'ambigua' | 'sin_director' | 'sin_anio' | 'nada' };

async function identificar(p: PeliPluto): Promise<Veredicto> {
  if (!p.anio) return { tipo: 'sin_anio' };
  const vistos = new Map<number, any>();
  for (const lang of ['es-MX', 'en-US']) {
    const r = await tmdb('/search/movie', { query: p.nombre, language: lang, include_adult: false });
    for (const c of (r.results || []).slice(0, 6)) {
      const y = Number(String(c.release_date || '').slice(0, 4));
      if (y && Math.abs(y - p.anio) <= 1) vistos.set(c.id, c);
    }
  }
  if (!vistos.size) return { tipo: 'nada' };
  if (!p.directores.length) return { tipo: 'sin_director' };

  const pasan: number[] = [];
  for (const id of vistos.keys()) {
    const d = await tmdb(`/movie/${id}`, { append_to_response: 'credits' });
    const dirs = (d.credits?.crew || []).filter((c: any) => c.job === 'Director').map((c: any) => norm(c.name));
    const director = dirs.some((x: string) => p.directores.includes(x));
    // Pluto a veces recorta créditos; 8 min de margen, y sin runtime en TMDB no se castiga.
    const duracion = !d.runtime || !p.minutos || Math.abs(d.runtime - p.minutos) <= 8;
    if (director && duracion) pasan.push(id);
  }
  if (pasan.length === 1) return { tipo: 'verificada', tmdbId: pasan[0] };
  return { tipo: pasan.length > 1 ? 'ambigua' : 'nada' };
}

async function enParalelo<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < xs.length) { const k = i++; out[k] = await fn(xs[k], k); }
  }));
  return out;
}

async function nuestrosIds(): Promise<Set<number>> {
  const out = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from('media_items').select('tmdb_id').eq('type', 'movie').gt('tmdb_id', 0)
      .order('tmdb_id').range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.add(Number(r.tmdb_id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Master → audio y primera variante → que el primer segmento y su clave respondan. Sin bajar vídeo. */
async function reproduce(boot: Boot, p: PeliPluto) {
  const base = `${boot.servers.stitcher}/v2${p.hls}`;
  const url = `${base}?${boot.stitcherParams}&jwt=${boot.sessionToken}&masterJWTPassthrough=true`;
  const master: string = (await axios.get(url, { timeout: 15000, responseType: 'text' })).data;
  const audios = [...master.matchAll(/TYPE=AUDIO[^\n]*LANGUAGE="([^"]+)"[^\n]*NAME="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  const variante = master.split('\n').find((l) => l && !l.startsWith('#'));
  if (!variante) return { ok: false, audios, motivo: 'master sin variantes' };
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  const pl: string = (await axios.get(new URL(variante.trim(), dir).toString(), { timeout: 15000, responseType: 'text' })).data;
  const segs = pl.split('\n').filter((l) => l && !l.startsWith('#'));
  // El primer bloque suele ser el ident de Pluto o un anuncio: se mira el segmento de la mitad.
  const seg = segs[Math.floor(segs.length / 2)];
  const cod = seg ? (await axios.get(seg, { headers: { Range: 'bytes=0-1023' }, timeout: 15000, validateStatus: () => true })).status : 0;
  const drm = /EXT-X-KEY:METHOD=SAMPLE-AES|com\.widevine/i.test(pl) ? 'widevine' : /METHOD=AES-128/.test(pl) ? 'aes-128' : 'claro';
  return { ok: cod === 200 || cod === 206, audios, motivo: `seg ${cod} · ${segs.length} segs · ${drm}` };
}

async function main() {
  const boot = await arrancar();
  const s = boot.session;
  console.log(`Sesión Pluto: país ${s.countryCode} · región ${s.activeRegion} · mercado ${s.marketingRegion}`);

  const { categorias, items } = await catalogo(boot);
  const pelisTodas = items.filter((i) => i.type === 'movie').map(aPeli);
  const series = items.filter((i) => i.type === 'series');
  console.log(`\n── INVENTARIO ──`);
  console.log(`  categorías: ${categorias} · películas: ${pelisTodas.length} · series: ${series.length}`);
  console.log(`  películas con año: ${pelisTodas.filter((p) => p.anio).length} · con director: ${pelisTodas.filter((p) => p.directores.length).length} · con hls: ${pelisTodas.filter((p) => p.hls).length}`);

  const pelis = LIMITE ? pelisTodas.slice(0, LIMITE) : pelisTodas;
  console.log(`\n── IDENTIFICACIÓN contra TMDB (${pelis.length} películas; año ±1 + director + duración ±8) ──`);
  let hechas = 0;
  const vs = await enParalelo(pelis, 8, async (p) => {
    let v: Veredicto;
    try { v = await identificar(p); } catch { v = { tipo: 'nada' }; }
    if (++hechas % 200 === 0) console.log(`  … ${hechas}/${pelis.length}`);
    return v;
  });
  const cuenta: Record<string, number> = {};
  vs.forEach((v) => (cuenta[v.tipo] = (cuenta[v.tipo] || 0) + 1));
  console.log(`  ${Object.entries(cuenta).map(([k, n]) => `${k}=${n}`).join(' · ')}`);

  const ya = await nuestrosIds();
  const verificadas = pelis.map((p, i) => ({ p, v: vs[i] })).filter((x) => x.v.tipo === 'verificada') as { p: PeliPluto; v: { tipo: 'verificada'; tmdbId: number } }[];
  const idsUnicos = new Set(verificadas.map((x) => x.v.tmdbId));
  const nuevas = verificadas.filter((x) => !ya.has(x.v.tmdbId));
  console.log(`\n── APORTE ──`);
  console.log(`  catálogo propio (películas con tmdb_id): ${ya.size}`);
  console.log(`  verificadas: ${verificadas.length} (tmdb_id distintos ${idsUnicos.size}) · ya las tenemos: ${verificadas.length - nuevas.length} · NUEVAS: ${new Set(nuevas.map((x) => x.v.tmdbId)).size}`);
  console.log(`  ejemplos nuevas: ${nuevas.slice(0, 10).map((x) => `${x.p.nombre} (${x.p.anio}) → ${x.v.tmdbId}`).join(' | ')}`);

  console.log(`\n── ¿REPRODUCE? (${N_REPRO} de las verificadas, repartidas) ──`);
  const paso = Math.max(1, Math.floor(verificadas.length / N_REPRO));
  const muestra = verificadas.filter((_, i) => i % paso === 0).slice(0, N_REPRO);
  const idiomas: Record<string, number> = {};
  let ok = 0;
  for (const { p } of muestra) {
    try {
      const r = await reproduce(boot, p);
      if (r.ok) ok++;
      const principal = r.audios[0]?.split(':')[0] || '¿?';
      idiomas[principal] = (idiomas[principal] || 0) + 1;
      console.log(`  ${r.ok ? '✔' : '✘'} ${p.nombre} (${p.anio}) · audio [${r.audios.join(', ') || '—'}] · ${r.motivo}`);
    } catch (e: any) {
      console.log(`  ✘ ${p.nombre} (${p.anio}) · ${e?.response?.status || e?.message}`);
    }
  }
  console.log(`  reproducen: ${ok}/${muestra.length} · audio principal: ${Object.entries(idiomas).map(([k, n]) => `${k}=${n}`).join(' · ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
