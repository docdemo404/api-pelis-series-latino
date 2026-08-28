/**
 * ¿QUÉ PARTE DE LO ANUNCIADO NO REPRODUCE, Y DE QUIÉN ES?
 *
 * El usuario reporta títulos sin enlace de uno en uno. Esto contesta lo que un caso suelto no
 * puede: cuántos son, y si el culpable es una fuente concreta. Se pregunta por el camino REAL —
 * lo que la API le entrega al cliente— y se baja el manifiesto, no se mira la base de datos: una
 * fila puede tener un servidor precioso que hoy da 403.
 *
 *   npx ts-node --transpile-only scripts/dev/diag_lo_que_no_reproduce.ts [--n=60]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';

const BASE = process.env.API_BASE || 'https://api-catalogo-latino.vercel.app';
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 60);
const db = getSupabaseAdmin();

async function pide(url: string) {
  try {
    return await httpClient.get(url, { timeout: 45000, responseType: 'text',
      transformResponse: [(d: unknown) => d], validateStatus: () => true });
  } catch (e: any) { return { status: 0, data: String(e?.code || e?.message) } as any; }
}

/** De qué fuente es la url del embed que lleva dentro el `direct_stream`. */
function fuenteDe(sv: any): string {
  const e = String(sv?.direct_stream || '').match(/[?&]e=([A-Za-z0-9_-]+)/)?.[1];
  const embed = e ? Buffer.from(e, 'base64url').toString() : String(sv?.embed_url || '');
  if (/videoapi\.la|videoapp\.zip/i.test(embed)) return 'videoapi';
  if (/vimeos\./i.test(embed)) return 'vimeos suelto';
  if (/archive\.org/i.test(embed)) return 'archive';
  if (/fuegocine|blogspot/i.test(embed)) return 'fuegocine';
  try { return new URL(embed).hostname.replace(/^www\./, ''); } catch { return sv?.source_id || '?'; }
}

async function main() {
  const { data } = await db.from('media_items')
    .select('id,title,type').eq('has_streams', true).limit(N * 3);
  const filas = (data || []).sort(() => Math.random() - 0.5).slice(0, N);

  const porFuente: Record<string, { ok: number; mal: number; ej: string[] }> = {};
  let sinServidor = 0;

  for (const f of filas) {
    const r = await pide(`${BASE}/api/v1/media/${encodeURIComponent(f.id)}/streams`);
    let d: any = null;
    try { d = JSON.parse(String(r.data)); d = d.data || d; } catch {}
    const sv = (d?.servers || [])[0]
      || ((d?.seasons || []).flatMap((t: any) => t?.episodes || []).find((e: any) => (e?.servers || []).length)?.servers || [])[0];
    if (!sv?.direct_stream) { sinServidor++; console.log(`  SIN SERVIDOR  ${f.title}`); continue; }

    const fuente = fuenteDe(sv);
    porFuente[fuente] ||= { ok: 0, mal: 0, ej: [] };
    const m = await pide(String(sv.direct_stream));
    const bien = m.status === 200 && String(m.data).startsWith('#EXTM3U');
    if (bien) porFuente[fuente].ok++;
    else {
      porFuente[fuente].mal++;
      if (porFuente[fuente].ej.length < 3) porFuente[fuente].ej.push(`${f.title} (${m.status})`);
    }
  }

  console.log(`\nDe ${filas.length} fichas anunciadas · ${sinServidor} sin servidor que entregar\n`);
  console.log('fuente del 1er servidor    reproduce   NO    ejemplos');
  for (const [k, v] of Object.entries(porFuente).sort((a, b) => b[1].mal - a[1].mal)) {
    console.log(`${k.padEnd(26)} ${String(v.ok).padStart(6)} ${String(v.mal).padStart(6)}    ${v.ej.join(' | ').slice(0, 70)}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
