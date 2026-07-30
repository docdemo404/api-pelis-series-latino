/**
 * POR QUÉ no se extrae el vídeo, host por host y con muestra suficiente.
 *
 * "No se puede extraer" mezcla cuatro cosas muy distintas, y hasta que no se separan no se sabe
 * dónde hay trabajo que hacer:
 *
 *   MUERTO        el fichero ya no existe en el host (borrado, caducado, 404/410, dominio
 *                 aparcado en `wwN.`). No hay nada que extraer: el servidor hay que retirarlo.
 *   EXTRAÍDO      el extractor actual SÍ saca el vídeo. Si la ficha no lo tiene guardado es que
 *                 se scrapeó antes de que existiera el extractor: se arregla repasándola.
 *   SIN EXTRACTOR la página está viva y tiene reproductor, pero no encontramos la URL. Aquí sí
 *                 hay que escribir código.
 *   RED           no llegamos a mirar (TLS, DNS, timeout). Problema nuestro o del host.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_extraccion.ts [--muestras=10] [--hosts=20]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpGetHtml, USER_AGENT } from '../../src/utils/httpClient';
import { extractDirect, unwrapRedirector } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const MUESTRAS = Number(arg('muestras', '10'));
const HOSTS = Number(arg('hosts', '20'));

type Motivo = 'MUERTO' | 'EXTRAÍDO' | 'SIN EXTRACTOR' | 'RED';

/** Lo que dicen estos hosts cuando el fichero ya no está. */
const SENALES_DE_MUERTO = [
  /no longer available/i,
  /has been deleted/i,
  /file (was )?(not found|deleted|removed)/i,
  /video (was )?(not found|removed|deleted|unavailable)/i,
  /404\s*[-–]\s*(no encontrado|not found)/i,
  /this (file|video) (is|was) (gone|removed)/i,
  /(fichero|archivo) no (existe|disponible)/i,
  /expired/i,
];

function hostDe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '(ilegible)';
  }
}

async function clasificar(embedUrl: string, referer?: string): Promise<{ motivo: Motivo; nota: string }> {
  const url = unwrapRedirector(embedUrl);
  let html = '';
  let status = 0;
  let finalUrl = url;
  try {
    const res = await httpGetHtml(url, {
      headers: { Referer: referer || 'https://tioplus.app/', 'User-Agent': USER_AGENT },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
    });
    status = res.status;
    html = String(res.data || '');
    finalUrl = res.request?.res?.responseUrl || url;
  } catch (e: any) {
    return { motivo: 'RED', nota: e.code || String(e.message).slice(0, 40) };
  }

  // El vídeo manda: si sale, da igual lo que diga el resto de la página.
  const directo = await extractDirect(url, html, { allowNetwork: true });
  if (directo) return { motivo: 'EXTRAÍDO', nota: directo.kind };

  if (status === 404 || status === 410 || status === 451) return { motivo: 'MUERTO', nota: `HTTP ${status}` };
  // `wwN.host` es el aparcamiento de dominio típico: el host dejó de servir vídeo.
  if (/^ww\d+\./i.test(hostDe(finalUrl))) return { motivo: 'MUERTO', nota: 'dominio aparcado' };
  const senal = SENALES_DE_MUERTO.find(re => re.test(html));
  if (senal) return { motivo: 'MUERTO', nota: (html.match(senal) || [''])[0].slice(0, 30) };
  if (status >= 400) return { motivo: 'MUERTO', nota: `HTTP ${status}` };

  return { motivo: 'SIN EXTRACTOR', nota: `HTTP ${status} · ${html.length}B` };
}

/** Ejecuta en paralelo con tope, para no tardar media hora ni tumbar a nadie. */
async function enParalelo<T, R>(items: T[], limite: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limite) {
    out.push(...(await Promise.all(items.slice(i, i + limite).map(fn))));
  }
  return out;
}

(async () => {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,servers,source_url')
      .not('servers', 'eq', '[]')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  // Solo embeds SIN vídeo directo guardado: son exactamente los que la pregunta señala.
  const porHost = new Map<string, { url: string; fuente?: string }[]>();
  let totalSinDirecto = 0;
  for (const f of filas) {
    for (const s of (f.servers || []).filter((x: any) => x?.embed_url && !x.direct_stream)) {
      totalSinDirecto++;
      const h = hostDe(s.embed_url);
      const lista = porHost.get(h) || [];
      lista.push({ url: s.embed_url, fuente: f.source_url });
      porHost.set(h, lista);
    }
  }

  const ranking = Array.from(porHost.entries()).sort((a, b) => b[1].length - a[1].length);
  console.log(`servidores sin vídeo directo: ${totalSinDirecto} en ${ranking.length} hosts`);
  console.log(`sondeando ${MUESTRAS} muestras de los ${HOSTS} hosts que más pesan\n`);
  console.log('host                              total   muerto  extraído  sin-extr  red   veredicto');

  const pendientes: Array<{ host: string; total: number; nota: string }> = [];
  for (const [host, todos] of ranking.slice(0, HOSTS)) {
    // Muestra repartida por todo el listado, no las primeras N (que suelen ser de la misma ficha).
    const paso = Math.max(1, Math.floor(todos.length / MUESTRAS));
    const muestra = Array.from({ length: Math.min(MUESTRAS, todos.length) }, (_, i) => todos[i * paso]).filter(Boolean);

    const res = await enParalelo(muestra, 5, m => clasificar(m.url, m.fuente));
    const cuenta = (m: Motivo) => res.filter(r => r.motivo === m).length;
    const muerto = cuenta('MUERTO');
    const extraido = cuenta('EXTRAÍDO');
    const sinExtractor = cuenta('SIN EXTRACTOR');
    const red = cuenta('RED');

    const notaSin = res.find(r => r.motivo === 'SIN EXTRACTOR')?.nota || '';
    const notaRed = res.find(r => r.motivo === 'RED')?.nota || '';
    let veredicto = '';
    if (extraido === res.length) veredicto = 'ya extrae — solo hay que repasar las fichas';
    else if (muerto === res.length) veredicto = 'host MUERTO — retirar sus servidores';
    else if (sinExtractor > 0) veredicto = `falta extractor (${notaSin})`;
    else if (red === res.length) veredicto = `no se alcanza (${notaRed})`;
    else veredicto = 'mixto';

    console.log(
      `${host.slice(0, 32).padEnd(33)} ${String(todos.length).padStart(5)}   ${String(muerto).padStart(4)}   ` +
        `${String(extraido).padStart(6)}   ${String(sinExtractor).padStart(7)}  ${String(red).padStart(4)}   ${veredicto}`
    );
    if (sinExtractor > 0 || red === res.length) pendientes.push({ host, total: todos.length, nota: veredicto });
  }

  console.log('\n───── Donde hay código que escribir, por servidores en juego:');
  for (const p of pendientes.sort((a, b) => b.total - a.total)) {
    console.log(`   ${p.host.padEnd(33)} ${String(p.total).padStart(5)} servidores · ${p.nota}`);
  }
})();
