import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient, streamClient, USER_AGENT } from '../../src/utils/httpClient';
import { extractDirect } from '../../src/scrapers/directStream';

/**
 * ¿EXTRAE Y ENTREGA ESTE HOST, PEDIDO DESDE UNA RED DOMÉSTICA?
 *
 * Nació para decidir si vidhideplus se podía rescatar moviendo la resolución al móvil: su veto
 * (`noSePuedeServirDirecto` en hostPolicy.ts) se puso midiendo DESDE VERCEL —ata la URL a la IP
 * que la acuña y estrangula a las IP de datacenter—, y esta máquina tiene IP residencial igual
 * que un móvil, así que sirve para separar «lo veta el host» de «lo vetamos nosotros por estar
 * en medio». Respuesta para vidhideplus: ninguna de las dos. Sus ficheros están BORRADOS — el
 * dominio redirige a callistanise.com y contesta «File is no longer available as it expired or
 * has been deleted» en 5 de 5. No había nada que rescatar.
 *
 * Se queda porque la pregunta es reutilizable: separa las tres cosas que se confunden entre sí
 * cuando un título no reproduce —el extractor no saca la URL, el host no entrega el vídeo, o no
 * lo hemos guardado— y cada una tiene un arreglo distinto.
 *
 * SE BAJA HASTA EL SEGMENTO. En HLS la primera respuesta es el manifiesto, unos cientos de bytes
 * de texto; exigirle 64 KB da por muerto a un host sano. Es el error que ya se cometió en
 * `--entrega` y que casi esconde 720 fichas, con emturbovid devolviendo 583 bytes de `#EXTM3U`
 * impecable. Aquí se sigue la cadena entera, como ExoPlayer.
 *
 *   npx ts-node scripts/dev/probe_entrega_host.ts emturbovid 8
 *   npx ts-node scripts/dev/probe_entrega_host.ts vidhide 8
 */

const HOST = process.argv[2] || 'emturbovid';
const CUANTOS = Number(process.argv[3]) || 8;

async function main() {
  const db = getSupabaseAdmin();
  const embeds: string[] = [];
  let ultimo = '';

  while (embeds.length < CUANTOS) {
    let q = db.from('media_items').select('id,servers').order('id', { ascending: true }).limit(300);
    if (ultimo) q = q.gt('id', ultimo);
    const { data, error } = await q;
    if (error) { console.error('error leyendo el catálogo:', error.message); return; }
    if (!data || data.length === 0) break;
    for (const row of data as any[]) {
      for (const s of row.servers || []) {
        if (embeds.length >= CUANTOS) break;
        const u = s?.embed_url || '';
        if (u.toLowerCase().includes(HOST) && !embeds.includes(u)) embeds.push(u);
      }
    }
    ultimo = (data[data.length - 1] as any).id;
    if (data.length < 300) break;
  }

  console.log(`🔎 ${embeds.length} embeds de "${HOST}", extraídos y medidos desde ESTA red (residencial)\n`);

  let extraidos = 0;
  let entregan = 0;
  const velocidades: number[] = [];

  for (const embed of embeds) {
    process.stdout.write(`${embed.slice(0, 58).padEnd(59)}`);

    let html = '';
    try {
      const r = await httpClient.get(embed, {
        headers: { 'User-Agent': USER_AGENT, Referer: embed },
        timeout: 15000,
        responseType: 'text',
        transformResponse: [(d: unknown) => d],
        validateStatus: () => true,
      });
      if (r.status !== 200) { console.log(`embed ${r.status}`); continue; }
      html = String(r.data || '');
    } catch (e: any) { console.log(`embed ERR ${e.code || e.message}`); continue; }

    let directa: string | null = null;
    try {
      const ex: any = await extractDirect(embed, html, { allowNetwork: true });
      directa = (ex && ex.url) || (typeof ex === 'string' ? ex : null);
    } catch (e: any) { console.log(`extractor ERR ${e.message}`); continue; }

    if (!directa) { console.log('no extrae'); continue; }
    extraidos++;

    // Cadena completa: maestro → variante → segmento. Solo cuentan los bytes del final.
    const t = Date.now();
    const pasos: string[] = [];
    let url = directa;
    let ok = false;
    let bytes = 0;
    try {
      for (let salto = 0; salto < 3; salto++) {
        const r = await streamClient.get(url, {
          headers: { 'User-Agent': USER_AGENT, Referer: embed, Range: 'bytes=0-524287' },
          responseType: 'arraybuffer',
          timeout: 45000,
          maxRedirects: 5,
          validateStatus: () => true,
        });
        const buf = Buffer.from((r.data as any) || []);
        pasos.push(`${r.status}/${buf.length}B`);
        if (r.status !== 200 && r.status !== 206) break;

        if (!buf.slice(0, 16).toString('utf8').startsWith('#EXTM3U')) {
          bytes = buf.length;
          ok = buf.length > 65536;
          break;
        }
        const lineas = buf.toString('utf8').split('\n').map(l => l.trim());
        const siguiente = lineas.find(l => l.length > 0 && l.charAt(0) !== '#');
        if (!siguiente) break;
        url = new URL(siguiente, url).toString();
      }
      const seg = (Date.now() - t) / 1000;
      const kbs = bytes / 1024 / Math.max(0.001, seg);
      if (ok) { entregan++; velocidades.push(kbs); }
      console.log(`${ok ? '✅' : '❌'} ${pasos.join('→')} · ${seg.toFixed(1)}s${ok ? ` · ${kbs.toFixed(0)} KB/s` : ''}`);
    } catch (e: any) {
      console.log(`❌ ${pasos.join('→')} ERR ${e.code || e.message}`);
    }
  }

  const media = velocidades.length
    ? Math.round(velocidades.reduce((a, b) => a + b, 0) / velocidades.length)
    : null;

  console.log('\n──────────────────────────────────────────────');
  console.log(`  embeds probados        ${embeds.length}`);
  console.log(`  el extractor saca URL  ${extraidos}`);
  console.log(`  ENTREGAN VÍDEO         ${entregan}`);
  console.log(`  velocidad media        ${media === null ? 'n/a' : media + ' KB/s'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
