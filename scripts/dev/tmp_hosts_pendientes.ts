/**
 * Una sola lectura del catálogo para sacar muestras de los hosts que quedan por decidir,
 * y ver QUÉ sirven de verdad. No clasifica: enseña, que es lo que falta ahora.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpGetHtml, USER_AGENT } from '../../src/utils/httpClient';
import { unwrapRedirector, extractDirect } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const HOSTS = ['vudeo.co', 'unlimplay.com', 'ahvsh.com', 'streamlare.com'];
const POR_HOST = 4;

(async () => {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('media_items').select('id,servers,source_url').not('servers', 'eq', '[]').range(from, from + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  const porHost = new Map<string, string[]>();
  for (const f of filas) for (const s of f.servers || []) {
    const u: string = s?.embed_url || '';
    if (!u || s.direct_stream) continue;
    const h = HOSTS.find(x => u.includes(x));
    if (!h) continue;
    const l = porHost.get(h) || [];
    if (l.length < 200) l.push(u);
    porHost.set(h, l);
  }

  for (const host of HOSTS) {
    const todos = porHost.get(host) || [];
    console.log(`\n================ ${host} · ${todos.length} embeds sin directo (muestra ${POR_HOST})`);
    const paso = Math.max(1, Math.floor(todos.length / POR_HOST));
    for (let i = 0; i < POR_HOST && i * paso < todos.length; i++) {
      const original = todos[i * paso];
      const url = unwrapRedirector(original);
      console.log(`\n--- ${original}`);
      if (url !== original) console.log(`    (desenvuelto → ${url})`);
      try {
        const r = await httpGetHtml(url, {
          headers: { Referer: 'https://tioplus.app/', 'User-Agent': USER_AGENT },
          timeout: 15000, maxRedirects: 5, validateStatus: () => true,
          responseType: 'text', transformResponse: [(d: unknown) => d],
        });
        const html = String(r.data || '');
        const finalUrl = (r as any).request?.res?.responseUrl || url;
        console.log(`    HTTP ${r.status} · ${html.length}B · final=${finalUrl}`);
        const titulo = (html.match(/<title[^>]*>([^<]{0,90})/i) || [])[1] || '';
        console.log(`    <title> ${titulo.trim()}`);
        const directo = await extractDirect(url, html, { allowNetwork: true });
        console.log(`    extractDirect → ${directo ? directo.kind + ' ' + directo.url.slice(0, 110) : 'null'}`);
        // pistas de qué hay dentro
        const pistas = ['EMBEDS', 'sources', 'eval(function(p,a,c,k,e', 'm3u8', '.mp4', 'jwplayer', 'videojs', 'not found', 'deleted', 'File was', 'Video not'];
        console.log(`    contiene: ${pistas.filter(p => html.includes(p)).join(', ') || '(nada reconocible)'}`);
        if (html.length < 2500) console.log(`    cuerpo: ${html.replace(/\s+/g, ' ').slice(0, 500)}`);
      } catch (e: any) {
        console.log(`    EXCEPCIÓN ${e.code || e.message}`);
      }
    }
  }
})();
