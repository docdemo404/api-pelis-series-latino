/**
 * Recorre embeds reales de la familia upns: /api/v1/info + /api/v1/video descifrado,
 * para encontrar uno VIVO con el que ver la construcción de la URL.
 */
import 'dotenv/config';
import crypto from 'crypto';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';

const db = getSupabaseAdmin();
const KEY = Buffer.from('kiemtienmua911ca', 'utf8');
const IV = Buffer.from('1234567890oiuytr', 'utf8');
const FAMILIA = ['upns.pro', 'upns.online', 'strp2p', 'rpmstream', '4meplayer'];

function descifrar(hex: string): any {
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
    return JSON.parse(Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8'));
  } catch { return null; }
}

(async () => {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('media_items').select('id,servers').not('servers', 'eq', '[]').range(from, from + 999);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }
  const urls: string[] = [];
  for (const f of filas) for (const s of f.servers || []) {
    const u = s?.embed_url || '';
    if (u && FAMILIA.some(h => u.includes(h)) && u.split('#')[1]) urls.push(u);
  }
  // muestra repartida
  const paso = Math.max(1, Math.floor(urls.length / 25));
  const muestra = Array.from({ length: 25 }, (_, i) => urls[i * paso]).filter(Boolean);

  console.log(`${urls.length} embeds upns · probando ${muestra.length}\n`);
  for (const embedUrl of muestra) {
    const id = embedUrl.split('#')[1];
    const origin = new URL(embedUrl).origin;
    let info = '';
    try {
      const r = await httpClient.get(`${origin}/api/v1/info?id=${id}`, {
        headers: { Referer: embedUrl }, timeout: 8000, responseType: 'text',
        transformResponse: [(d: unknown) => d], validateStatus: () => true,
      });
      info = `info ${r.status} ${String(r.data || '').slice(0, 90).replace(/\s+/g, ' ')}`;
    } catch (e: any) { info = 'info ERR ' + e.code; }

    let vid = '';
    try {
      const r = await httpClient.get(`${origin}/api/v1/video?id=${id}&w=1920&h=1080&r=tioplus.app`, {
        headers: { Referer: embedUrl }, timeout: 8000, responseType: 'text',
        transformResponse: [(d: unknown) => d], validateStatus: () => true,
      });
      if (r.status !== 200) vid = `video ${r.status}`;
      else {
        const p = descifrar(String(r.data || '').trim());
        if (!p) vid = 'video 200 pero no descifra';
        else {
          // Los CUATRO campos que el reproductor mapea a su `order`, más el nativo de Safari.
          const campos = ['cf', 'cfNative', 'hlsVideoTiktok', 'hlsVideoGoogle', 'source']
            .filter(k => typeof p[k] === 'string' && p[k]);
          const listo = Boolean(p.source && p.player);   // el propio guard del reproductor
          vid = `video 200 · listo=${listo} · campos=[${campos.join(',')}]`;
          if (campos.length) vid += `\n   ejemplo ${campos[0]} = ${String(p[campos[0]]).slice(0, 130)}`;
        }
      }
    } catch (e: any) { vid = 'video ERR ' + e.code; }

    console.log(`${embedUrl}\n   ${info}\n   ${vid}\n`);
  }
})();
