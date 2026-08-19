/**
 * listeamed.net es el mayor host sin extractor (7.414 servidores). Su primera respuesta es una
 * redirección con un JWT que él mismo emite, así que puede que solo haga falta seguirla.
 * Esto sigue la cadena entera con las cookies puestas y dice dónde se corta.
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';
import { unpackPacker } from '../../src/scrapers/directStream';

const db = getSupabaseAdmin();
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 6);
const RE_VIDEO = /https?:\/\/[^\s"'<>\\)]+\.(?:m3u8|mp4)[^\s"'<>\\)]*/g;

const NAV = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
};

const get = (u: string, ref: string, cookie = '') =>
  httpClient.get(u, {
    headers: { ...NAV, Referer: ref, ...(cookie ? { Cookie: cookie } : {}) },
    timeout: 25000, responseType: 'text',
    transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
  } as any);

const cookiesDe = (r: any) => (r.headers['set-cookie'] || []).map((c: string) => c.split(';')[0]).join('; ');

function mirar(html: string): { hay: string | null; nota: string } {
  const directas = [...new Set(html.match(RE_VIDEO) || [])];
  if (directas.length) return { hay: directas[0], nota: '' };
  if (/eval\(function\(p,a,c,k,e/.test(html)) {
    const abierto = unpackPacker(html) || '';
    const dentro = [...new Set(abierto.match(RE_VIDEO) || [])];
    if (dentro.length) return { hay: dentro[0], nota: 'en packer' };
    return { hay: null, nota: 'packer sin url' };
  }
  if (/hcaptcha|g-recaptcha|turnstile/i.test(html)) return { hay: null, nota: 'CAPTCHA' };
  if (/canvas|webgl|fingerprint/i.test(html)) return { hay: null, nota: 'huella (canvas/webgl)' };
  if (/cmp\.php|gdprApplies|consent/i.test(html)) return { hay: null, nota: 'capa de consentimiento' };
  return { hay: null, nota: `sin pistas (${html.length} B)` };
}

(async () => {
  const embeds: string[] = [];
  for (let from = 0; from < 15000 && embeds.length < N; from += 500) {
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
        if (u.includes('listeamed') && !embeds.includes(u)) embeds.push(u);
        if (embeds.length >= N) break;
      }
      if (embeds.length >= N) break;
    }
  }

  console.log(`${embeds.length} embeds de listeamed.net\n`);
  const resumen: Record<string, number> = {};

  for (const embed of embeds) {
    console.log(`── ${embed}`);
    try {
      const r1 = await get(embed, 'https://tioplus.app/');
      const h1 = String(r1.data || '');
      const galletas = cookiesDe(r1);
      const salto = h1.match(/window\.location\.replace\(['"]([^'"]+)['"]/)?.[1];
      if (!salto) {
        const v = mirar(h1);
        console.log(`   sin salto · ${v.hay ? `VÍDEO ${v.hay}` : v.nota}`);
        resumen[v.hay ? 'VÍDEO' : v.nota] = (resumen[v.hay ? 'VÍDEO' : v.nota] || 0) + 1;
        continue;
      }

      const r2 = await get(salto, embed, galletas);
      const h2 = String(r2.data || '');
      const v2 = mirar(h2);
      console.log(`   salto 1 (${h2.length} B) · ${v2.hay ? `VÍDEO ${v2.hay}` : v2.nota}`);
      if (v2.hay) { resumen['VÍDEO'] = (resumen['VÍDEO'] || 0) + 1; continue; }

      // Un tercer salto: su página de consentimiento suele reenviar al reproductor real.
      const salto2 = h2.match(/(?:window\.)?location\.(?:replace|href)\s*[=(]\s*['"]([^'"]+)['"]/)?.[1]
        || h2.match(/<iframe[^>]+src=["']([^"']+)["']/)?.[1];
      if (!salto2) {
        console.log(`   sin tercer salto`);
        resumen[v2.nota] = (resumen[v2.nota] || 0) + 1;
        continue;
      }
      const u3 = new URL(salto2.replace(/&amp;/g, '&'), salto).toString();
      const r3 = await get(u3, salto, cookiesDe(r2) || galletas);
      const h3 = String(r3.data || '');
      const v3 = mirar(h3);
      console.log(`   salto 2 (${h3.length} B) · ${v3.hay ? `VÍDEO ${v3.hay}` : v3.nota}`);
      resumen[v3.hay ? 'VÍDEO' : v3.nota] = (resumen[v3.hay ? 'VÍDEO' : v3.nota] || 0) + 1;
    } catch (e: any) {
      console.log(`   ERROR ${e.code || ''} ${e.message?.slice(0, 50)}`);
      resumen['red'] = (resumen['red'] || 0) + 1;
    }
  }

  console.log(`\nRESUMEN: ${Object.entries(resumen).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
})();
