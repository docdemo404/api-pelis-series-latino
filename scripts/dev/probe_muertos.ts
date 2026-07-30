/**
 * Auditoría de la retirada de servidores: ¿POR QUÉ se condena cada uno?
 *
 * Antes de borrar nada del catálogo hay que poder mirar una muestra y decir "sí, ese está muerto".
 * Este script enseña el veredicto con su motivo y el tamaño de la página, agrupado por host.
 *
 * Sirvió para desmontar una alarma: waaw.to salía con un 33% de bajas y parecía un falso positivo
 * porque sus páginas responden 200 con el título "Video player". No lo era — su página `/f/`
 * responde igual de bien esté el vídeo o no, y solo el iframe interno `/e/` enseña el "We're
 * Sorry!". El control ya bajaba hasta ahí; lo que faltaba era poder VERLO.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_muertos.ts [--muestras=8] [--host=x]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { inspectEmbed } from '../../src/scrapers/embedHealth';

const db = getSupabaseAdmin();
const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const MUESTRAS = Number(arg('muestras', '8'));
const SOLO = arg('host');

function hostDe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '(ilegible)';
  }
}

(async () => {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('media_items').select('id,servers').not('servers', 'eq', '[]').range(from, from + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  const porHost = new Map<string, string[]>();
  for (const f of filas) {
    for (const s of f.servers || []) {
      if (!s?.embed_url) continue;
      const h = hostDe(s.embed_url);
      if (SOLO && !h.includes(SOLO)) continue;
      const l = porHost.get(h) || [];
      if (l.length < 200) l.push(s.embed_url);
      porHost.set(h, l);
    }
  }

  for (const [host, urls] of Array.from(porHost).sort((a, b) => b[1].length - a[1].length).slice(0, SOLO ? 5 : 12)) {
    const paso = Math.max(1, Math.floor(urls.length / MUESTRAS));
    const muestra = Array.from({ length: Math.min(MUESTRAS, urls.length) }, (_, i) => urls[i * paso]).filter(Boolean);
    const res = await Promise.all(muestra.map(async u => ({ u, r: await inspectEmbed(u) })));
    const muertos = res.filter(x => x.r.status === 'offline');
    console.log(`\n═══ ${host}  ${muertos.length}/${res.length} muertos`);
    const porMotivo = new Map<string, number>();
    for (const m of muertos) porMotivo.set(m.r.motivo || '?', (porMotivo.get(m.r.motivo || '?') || 0) + 1);
    for (const [motivo, n] of porMotivo) console.log(`     ${n}× ${motivo}`);
    for (const m of muertos.slice(0, 2)) console.log(`     p.ej. ${m.u.slice(0, 88)}`);
  }
})();
