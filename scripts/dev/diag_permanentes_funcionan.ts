/**
 * De las fichas con URL de fichero permanente, ¿cuántas FUNCIONAN de verdad?
 *
 * Es la segunda mitad de lo pedido: «si no tiene url funcional, no se muestra». Una url que no
 * caduca no sirve de nada si devuelve 404. Se pide un trozo real con `Range` y se comprueba que
 * lo que llega es vídeo, no una página de error.
 *
 *   npx ts-node -T scripts/dev/diag_permanentes_funcionan.ts [--n=25]
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { hasVolatileToken } from '../../src/scrapers/directStream';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 25);

const FICHERO_DIRECTO = [
  /pixeldrain\.com\/api\/file\//i,
  /archive\.org\/download\//i,
  /1a-\d+\.com\/video\//i,
  /cdn\.rumble\.cloud\/video\//i,
  /remux\.unlimplay\.com\/remux/i,
  /\.(mp4|mkv|webm)(\?|$)/i,
];

function urlEnvuelta(embed: string): string | null {
  try {
    const q = new URL(embed).searchParams;
    for (const [, v] of q) {
      if (!v) continue;
      const cand = /^https?:\/\//i.test(v) ? v : (/^[\w.-]+\.[a-z]{2,}\//i.test(v) ? `https://${v}` : '');
      if (cand) return cand;
    }
  } catch { /* nada */ }
  return null;
}

const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };

/** ¿Devuelve bytes de vídeo? Se piden 64 KB: suficiente para ver la cabecera del contenedor. */
async function funciona(url: string): Promise<{ ok: boolean; nota: string }> {
  try {
    const r = await httpClient.get(url, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-65535' },
      responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true, maxRedirects: 5,
    } as any);
    const kb = ((r.data as ArrayBuffer)?.byteLength ?? 0) / 1024;
    const tipo = String(r.headers['content-type'] || '');
    if (r.status >= 400) return { ok: false, nota: `http ${r.status}` };
    if (/text\/html/i.test(tipo)) return { ok: false, nota: 'devuelve una página, no vídeo' };
    if (kb < 8) return { ok: false, nota: `solo ${kb.toFixed(1)} KB` };
    return { ok: true, nota: `${kb.toFixed(0)} KB · ${tipo.slice(0, 24)}` };
  } catch (e: any) {
    return { ok: false, nota: e.code || 'error de red' };
  }
}

(async () => {
  const candidatas: Array<{ titulo: string; url: string }> = [];
  let ultimoId = '';
  while (candidatas.length < N * 4) {
    const { data } = await supabase.from('media_items')
      .select('id,title,servers').gt('id', ultimoId).order('id').limit(500);
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;
    for (const r of data as any[]) {
      for (const s of (r.servers ?? [])) {
        if (s?.status === 'offline') continue;
        const embed = String(s?.embed_url || '');
        for (const cand of [urlEnvuelta(embed), embed]) {
          if (!cand || !FICHERO_DIRECTO.some(re => re.test(cand)) || hasVolatileToken(cand)) continue;
          candidatas.push({ titulo: String(r.title), url: cand });
          break;
        }
        break;
      }
    }
  }

  const muestra = candidatas.sort(() => Math.random() - 0.5).slice(0, N);
  console.log(`Comprobando ${muestra.length} urls permanentes\n`);
  let ok = 0;
  const porHost: Record<string, { ok: number; no: number }> = {};

  for (const c of muestra) {
    const h = hostDe(c.url);
    porHost[h] ??= { ok: 0, no: 0 };
    const r = await funciona(c.url);
    if (r.ok) { ok++; porHost[h].ok++; } else porHost[h].no++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${c.titulo.slice(0, 30).padEnd(30)} ${h.padEnd(22)} ${r.nota}`);
  }

  console.log(`\n  FUNCIONAN ${ok}/${muestra.length}  (${((ok / muestra.length) * 100).toFixed(0)}%)`);
  console.log(`\n  Por host:`);
  for (const [h, v] of Object.entries(porHost).sort((a, b) => (b[1].ok + b[1].no) - (a[1].ok + a[1].no))) {
    console.log(`     ${h.padEnd(24)} ${v.ok} funcionan · ${v.no} no`);
  }
})();
