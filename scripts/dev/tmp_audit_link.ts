/**
 * TEMPORAL. ¿Qué hay de verdad detrás de los `link=` que se publican como vídeo directo?
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

const db = getSupabaseAdmin();

function paramUrl(embed: string): string | null {
  try {
    const p = new URL(embed).searchParams;
    for (const k of ['link', 'url', 'file', 'source', 'src']) {
      const v = p.get(k);
      if (v && /^(https?:)?\/\//i.test(v)) return v.startsWith('//') ? 'https:' + v : v;
    }
  } catch {}
  return null;
}

(async () => {
  const filas: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,servers')
      .not('servers', 'eq', '[]')
      .range(f, f + 999);
    if (error) { console.error(error); break; }
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }
  console.log('fichas con servidores:', filas.length);

  const grupos = new Map<string, { n: number; ej: string[] }>();
  let totalConParam = 0;
  for (const fila of filas) {
    for (const s of fila.servers || []) {
      if (!s?.embed_url) continue;
      const dentro = paramUrl(s.embed_url);
      if (!dentro) continue;
      totalConParam++;
      let host = '(?)';
      try { host = new URL(dentro).hostname.replace(/^www\./, ''); } catch {}
      const ext = (dentro.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || '(sin ext)').toLowerCase();
      const clave = `${host}\t.${ext}\tdirect=${s.direct_stream ? s.direct_kind || 'si' : 'NO'}`;
      const g = grupos.get(clave) || { n: 0, ej: [] };
      g.n++;
      if (g.ej.length < 2) g.ej.push(dentro);
      grupos.set(clave, g);
    }
  }
  console.log('servidores con parámetro envuelto:', totalConParam, '| grupos:', grupos.size, '\n');
  for (const [clave, g] of Array.from(grupos).sort((a, b) => b[1].n - a[1].n)) {
    console.log(String(g.n).padStart(6), clave, '  ', g.ej[0].slice(0, 120));
  }
})();
