/**
 * `repfuegocinefree.blogspot.com` es el envoltorio propio de FuegoCine: lleva la url real dentro
 * de un parámetro. Saca vídeo directo en 880 servidores y NO en 1.267. Esto mira qué diferencia
 * a unos de otros.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { extractDirect } from '../../src/scrapers/directStream';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 14);

const get = (u: string, ref: string) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT, Referer: ref },
    timeout: 30000, responseType: 'text',
    transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
  } as any);

/** Qué host lleva dentro el envoltorio, mirando todos sus parámetros. */
function hostInterior(embed: string): string {
  try {
    const q = new URL(embed).searchParams;
    for (const [, v] of q) {
      if (!v) continue;
      const candidato = /^https?:\/\//i.test(v) ? v : (/^[\w.-]+\.[a-z]{2,}\//i.test(v) ? `https://${v}` : '');
      if (candidato) { try { return new URL(candidato).hostname.replace(/^www\./, ''); } catch { /* sigue */ } }
    }
    // A veces el valor viene en base64.
    for (const [, v] of q) {
      if (!v || v.length < 12) continue;
      try {
        const t = Buffer.from(v, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(t)) return new URL(t).hostname.replace(/^www\./, '');
      } catch { /* sigue */ }
    }
  } catch { /* nada */ }
  return '(sin url dentro)';
}

(async () => {
  const conDirecto: string[] = [];
  const sinDirecto: string[] = [];

  for (let from = 0; from < 15000; from += 500) {
    const { data } = await db.from('media_items').select('servers,seasons')
      .not('servers', 'eq', '[]').range(from, from + 499);
    if (!data?.length) break;
    for (const r of data as any[]) {
      const todos = [
        ...(r.servers ?? []),
        ...((r.seasons ?? []).flatMap((s: any) => s?.episodes ?? []).flatMap((e: any) => e?.servers ?? [])),
      ];
      for (const s of todos) {
        const u: string = s?.embed_url || '';
        if (!u.includes('repfuegocinefree')) continue;
        const destino = (s?.direct_stream && s.status !== 'offline') ? conDirecto : sinDirecto;
        if (destino.length < N && !destino.includes(u)) destino.push(u);
      }
    }
    if (conDirecto.length >= N && sinDirecto.length >= N) break;
  }

  for (const [etiqueta, lista] of [['CON vídeo directo', conDirecto], ['SIN vídeo directo', sinDirecto]] as const) {
    console.log(`\n${'='.repeat(72)}\n${etiqueta}  (${lista.length} muestras)`);
    const hosts: Record<string, number> = {};
    for (const u of lista) {
      const h = hostInterior(u);
      hosts[h] = (hosts[h] || 0) + 1;
    }
    console.log(`  host que llevan dentro:`);
    for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(3)}  ${h}`);
    console.log(`  ejemplo: ${lista[0]?.slice(0, 150) || '—'}`);
  }

  // Y sobre los que NO tienen: ¿los saca el extractor AHORA?
  console.log(`\n${'='.repeat(72)}\n¿Los saca hoy el extractor de producción?`);
  let ok = 0, muertos = 0, nada = 0;
  for (const u of sinDirecto.slice(0, 10)) {
    const r = await get(u, 'https://www.fuegocine.com/');
    const html = String(r.data || '');
    const d = await extractDirect(u, html, { allowNetwork: true }).catch(() => null);
    if (d) { ok++; console.log(`  ✓ ${hostInterior(u).padEnd(28)} ${d.kind} ${d.url.slice(0, 70)}`); }
    else if (r.status >= 400 || html.length < 400) { muertos++; console.log(`  · ${hostInterior(u).padEnd(28)} página ${r.status} (${html.length} B)`); }
    else { nada++; console.log(`  ✗ ${hostInterior(u).padEnd(28)} sin vídeo (${html.length} B)`); }
  }
  console.log(`\n  extrae ${ok} · página caída ${muertos} · no encuentra ${nada}`);
})();
