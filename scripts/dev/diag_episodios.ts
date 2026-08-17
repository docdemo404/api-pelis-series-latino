/**
 * ¿POR QUÉ NO REPRODUCE NINGÚN EPISODIO?
 *
 * Diagnóstico de solo lectura. No escribe en la base de datos ni en el catálogo: mide.
 *
 * Contesta a las tres preguntas que deciden el arreglo:
 *
 *   1. LÍNEA BASE — qué porcentaje de los S1E1 del catálogo contesta hoy `ready`. Sin este número
 *      no se puede demostrar después que nada haya mejorado.
 *   2. EL TOPE DE 5 — `realScraperService` resuelve `serverTokens.slice(0, 5)` y las páginas de
 *      episodio publican hasta 8. ¿Los tokens que nunca se miran son mejores que los que sí, o
 *      están igual de muertos? Aquí se resuelven TODOS y se reparte el resultado por posición.
 *   3. EXTRACTOR O PODREDUMBRE — un embed que responde pero del que no se puede sacar el vídeo es
 *      un extractor roto (se arregla y vuelve todo de golpe). Un embed que da 404 es un enlace
 *      podrido (no hay nada que arreglar: hace falta otra fuente). Se separan por familia de host.
 *
 * Y de paso mide lo que valdría fusionar las fuentes: hoy `scrapeEpisodeDetail` se queda con la
 * PRIMERA página que dé servidores y tira las demás, así que se cuenta cuántas series tienen vídeo
 * reproducible en una segunda fuente que hoy se está descartando.
 *
 *   npx tsx scripts/dev/diag_episodios.ts [--series=40] [--api=https://...] [--sin-base]
 */
import 'dotenv/config';
import * as cheerio from 'cheerio';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { RealScraperService, resolvePlayerUrl } from '../../src/services/realScraperService';
import { inspectEmbed } from '../../src/scrapers/embedHealth';
import { extractDirect } from '../../src/scrapers/directStream';
import { comprobarEmbed } from '../../src/services/playbackHealth';
import { USER_AGENT, httpClient } from '../../src/utils/httpClient';

const BASE_URL = 'https://tioplus.app';

const args = process.argv.slice(2);
const flag = (n: string, d: string) => (args.find(a => a.startsWith(`--${n}=`)) || `=${d}`).split('=').pop() as string;
const N_SERIES = parseInt(flag('series', '40'), 10);
const API = flag('api', 'https://api-pelis-series-latino.vercel.app').replace(/\/$/, '');
const SIN_BASE = args.includes('--sin-base');
/** Solo la línea base: es lo barato y lo que dice CUÁNTAS series fallan de verdad. */
const SOLO_BASE = args.includes('--solo-base');

/** El tope que hoy aplica realScraperService.ts:554. Lo que quede por encima no se mira nunca. */
const TOPE_ACTUAL = 5;

type Fila = { id: string; title: string; source_urls: string[] | null; source_url: string | null };

/** Corre `tareas` con como mucho `n` en vuelo. Las sondas salen a webs de terceros: sin esto son cientos a la vez. */
async function conCupo<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let siguiente = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = siguiente++;
        if (i >= items.length) return;
        try { out[i] = await fn(items[i], i); } catch { out[i] = undefined as any; }
      }
    })
  );
  return out;
}

function familiaDe(url: string): string {
  let h = '';
  try { h = new URL(url).hostname.replace(/^www\./, ''); } catch { return '(?)'; }
  if (/upns|upfast|pelisplus/i.test(h)) return 'upns';
  if (/ok\.ru|okcdn/i.test(h)) return 'okru';
  if (/blogspot|pixeldrain/i.test(h)) return 'blogspot/pixeldrain';
  if (/drive\.google|gdrive/i.test(h)) return 'drive';
  // Los demás se agrupan por dominio de segundo nivel para que la tabla no tenga 200 filas.
  return h.split('.').slice(-2).join('.');
}

/** Las mismas urls candidatas que construye scrapeEpisodeDetail, separadas por fuente. */
function candidatas(fila: Fila, s: number, e: number) {
  const urls = [...(fila.source_urls || []), fila.source_url].filter(Boolean) as string[];
  const tioplus = urls
    .map(u => u.match(/\/(serie|anime|dorama)\/([^/?#]+)/i))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map(m => `${BASE_URL}/${m[1].toLowerCase()}/${m[2]}/season/${s}/episode/${e}`);
  const fuegocine = urls
    .map(u => u.match(/^(https?:\/\/[^/]*fuegocine[^/]*\/\d{4}\/\d{2}\/.+?)-\d{1,2}x\d{1,3}(\.html)$/i))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map(m => `${m[1]}-${s}x${e}${m[2]}`);
  return { tioplus: [...new Set(tioplus)], fuegocine: [...new Set(fuegocine)] };
}

/**
 * `directo` significa que se pudo EXTRAER la url del vídeo, no que el vídeo se vea. Son cosas
 * distintas y la diferencia es justo lo que hay que medir: emturbovid entrega un maestro perfecto
 * cuyas variantes viven en dominios que ya no existen (ver la cabecera de manifestHealth.ts). Por
 * eso, cuando la extracción sale bien, se baja hasta el vídeo con la MISMA comprobación que usa
 * producción (`comprobarEmbed`) y se separa `reproduce` de `extrae-pero-no-reproduce`.
 */
type Veredicto =
  | 'reproduce'
  | 'extrae-pero-no-reproduce'
  | 'embed-vivo-sin-directo'
  | 'embed-muerto'
  | 'no-resuelve';

async function juzgarToken(token: string, referer: string): Promise<{ v: Veredicto; familia: string }> {
  const embedUrl = await resolvePlayerUrl(token, referer).catch(() => null);
  if (!embedUrl) return { v: 'no-resuelve', familia: '(sin resolver)' };
  const familia = familiaDe(embedUrl);
  const { status, html } = await inspectEmbed(embedUrl).catch(() => ({ status: 'offline', html: '' } as any));
  if (status === 'offline') return { v: 'embed-muerto', familia };
  const direct = await extractDirect(embedUrl, html).catch(() => null);
  if (!direct) return { v: 'embed-vivo-sin-directo', familia };

  const c = await comprobarEmbed(embedUrl, { limite: Date.now() + 25000 }).catch(() => null);
  // `desconocido` no condena: es la misma regla que aplica producción (fallar a favor del vídeo).
  const reproduce = !c || c.veredicto !== 'muerto';
  return { v: reproduce ? 'reproduce' : 'extrae-pero-no-reproduce', familia };
}

(async () => {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from('media_items')
    .select('id,title,source_urls,source_url')
    .eq('type', 'tvseries')
    .eq('has_streams', true)
    .limit(N_SERIES);
  if (error) { console.error(error); process.exit(1); }
  const filas = (data || []) as Fila[];
  console.log(`Series con has_streams=true en la muestra: ${filas.length}\n`);

  // ── 1. LÍNEA BASE ────────────────────────────────────────────────────────────────────────────
  if (!SIN_BASE) {
    console.log(`── LÍNEA BASE · S1E1 contra ${API}`);
    const estados = await conCupo(filas, 4, async fila => {
      try {
        const r = await httpClient.get(`${API}/api/v1/series/${encodeURIComponent(fila.id)}/season/1/episode/1`, {
          timeout: 60000, validateStatus: () => true,
        });
        return String(r.data?.data?.streams?.status || `http-${r.status}`);
      } catch { return 'error-red'; }
    });
    const cuenta = new Map<string, number>();
    for (const s of estados) cuenta.set(s || 'error-red', (cuenta.get(s || 'error-red') || 0) + 1);
    for (const [k, v] of [...cuenta].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${k.padEnd(14)} ${String(v).padStart(3)}  (${((v / filas.length) * 100).toFixed(0)}%)`);
    }
    console.log();
  }

  if (SOLO_BASE) return;

  // ── 2 y 3. TOKENS SIN TOPE, Y DE QUÉ MUEREN ─────────────────────────────────────────────────
  console.log('── TOKENS DE LAS PÁGINAS DE EPISODIO (TioPlus), resolviendo TODOS');
  const porPosicion = new Map<number, Map<Veredicto, number>>();
  const porFamilia = new Map<string, Map<Veredicto, number>>();
  const apunta = (m: Map<any, Map<Veredicto, number>>, k: any, v: Veredicto) => {
    if (!m.has(k)) m.set(k, new Map());
    const g = m.get(k)!;
    g.set(v, (g.get(v) || 0) + 1);
  };

  let seriesConPagina = 0;
  let alcanzableHoy = 0;       // series con ≥1 directo dentro de los 5 primeros tokens
  let alcanzableSinTope = 0;   // series con ≥1 directo en cualquier token

  await conCupo(filas, 3, async fila => {
    const { tioplus } = candidatas(fila, 1, 1);
    if (!tioplus.length) return;
    const url = tioplus[0];
    let html = '';
    try {
      const r = await httpClient.get(url, {
        headers: { 'User-Agent': USER_AGENT, Referer: BASE_URL }, timeout: 20000, validateStatus: () => true,
      });
      if (r.status >= 400) return;
      html = typeof r.data === 'string' ? r.data : '';
    } catch { return; }
    const $ = cheerio.load(html);
    const tokens = $('li[data-server]').map((_, el) => $(el).attr('data-server') || '').get().filter(Boolean);
    if (!tokens.length) return;
    seriesConPagina++;

    const veredictos = await conCupo(tokens, 4, t => juzgarToken(t, url));
    let hoy = false, sinTope = false;
    veredictos.forEach((r, i) => {
      if (!r) return;
      apunta(porPosicion, i + 1, r.v);
      apunta(porFamilia, r.familia, r.v);
      if (r.v === 'reproduce') { sinTope = true; if (i < TOPE_ACTUAL) hoy = true; }
    });
    if (hoy) alcanzableHoy++;
    if (sinTope) alcanzableSinTope++;
  });

  const ORD: Veredicto[] = ['reproduce', 'extrae-pero-no-reproduce', 'embed-vivo-sin-directo', 'embed-muerto', 'no-resuelve'];
  const cab = `   pos  ${ORD.map(v => v.padStart(26)).join('')}`;
  console.log(cab);
  for (const pos of [...porPosicion.keys()].sort((a, b) => a - b)) {
    const g = porPosicion.get(pos)!;
    const marca = pos > TOPE_ACTUAL ? '  ← hoy no se mira' : '';
    console.log(`   ${String(pos).padStart(3)}  ${ORD.map(v => String(g.get(v) || 0).padStart(26)).join('')}${marca}`);
  }

  console.log(`\n   Series con página de episodio: ${seriesConPagina}`);
  console.log(`   Con vídeo QUE REPRODUCE dentro del tope de ${TOPE_ACTUAL}: ${alcanzableHoy}`);
  console.log(`   Con vídeo QUE REPRODUCE en cualquier token    : ${alcanzableSinTope}`);
  console.log(`   → subir el tope recupera: ${alcanzableSinTope - alcanzableHoy} series\n`);

  console.log('── POR FAMILIA DE HOST  (embed-vivo-sin-directo = extractor roto · embed-muerto = enlace podrido)');
  console.log(cab.replace('pos ', 'host'.padEnd(4)));
  const filasFam = [...porFamilia.entries()].sort((a, b) => {
    const t = (m: Map<Veredicto, number>) => [...m.values()].reduce((x, y) => x + y, 0);
    return t(b[1]) - t(a[1]);
  });
  for (const [fam, g] of filasFam.slice(0, 15)) {
    console.log(`   ${fam.slice(0, 20).padEnd(20)}${ORD.map(v => String(g.get(v) || 0).padStart(26)).join('')}`);
  }

  // ── 4. LO QUE VALDRÍA FUSIONAR ───────────────────────────────────────────────────────────────
  console.log('\n── SEGUNDA FUENTE DESCARTADA (lo que hoy tira el `.find()` de scrapeEpisodeDetail)');
  let conSegunda = 0, segundaConDirecto = 0;
  await conCupo(filas, 3, async fila => {
    const { tioplus, fuegocine } = candidatas(fila, 1, 1);
    if (!tioplus.length || !fuegocine.length) return;   // solo donde de verdad se descarta algo
    conSegunda++;
    const d = await RealScraperService.scrapeDetail(fuegocine[0]).catch(() => null);
    if ((d?.servers || []).some(s => s.direct_stream)) segundaConDirecto++;
  });
  console.log(`   Series con una 2ª fuente que hoy se descarta: ${conSegunda}`);
  console.log(`   …y en la que SÍ hay vídeo directo            : ${segundaConDirecto}`);
})();
