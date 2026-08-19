/**
 * 767 fichas de FuegoCine (el 25 %) no tienen NI UN servidor guardado, y son títulos grandes
 * (Transformers, Akira, Aladdin). ¿Su página no publica enlaces, o el scraper no los ve?
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { RealScraperService } from '../../src/services/realScraperService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';

const N = Number((process.argv.find(a => a.startsWith('--n=')) || '').split('=')[1] || 8);
const esFuegocine = (id: string) => /^fc-/.test(id) || /^\d{4}-\d{2}-/.test(id);

const get = (u: string) =>
  httpClient.get(u, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 30000, responseType: 'text',
    transformResponse: [(d: unknown) => d], validateStatus: () => true, maxRedirects: 5,
  } as any);

(async () => {
  // Fichas de fuegocine sin servidores.
  const candidatas: any[] = [];
  let ultimoId = '';
  while (candidatas.length < N) {
    const { data } = await supabase.from('media_items')
      .select('id,title,type,source_url,source_urls,servers,streams_updated_at')
      .gt('id', ultimoId).order('id').limit(500);
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;
    for (const r of data as any[]) {
      if (!esFuegocine(r.id)) continue;
      if (Array.isArray(r.servers) && r.servers.length) continue;
      candidatas.push(r);
      if (candidatas.length >= N) break;
    }
  }

  console.log(`${candidatas.length} fichas de FuegoCine sin servidores\n`);
  let sinUrl = 0, paginaMuerta = 0, scraperCiego = 0, siHay = 0;

  for (const f of candidatas) {
    const url = f.source_url || (f.source_urls || [])[0];
    console.log(`«${f.title}»  ${f.id}`);
    console.log(`   resuelta por última vez: ${f.streams_updated_at ? String(f.streams_updated_at).slice(0, 19) : 'NUNCA'}`);
    if (!url) { console.log('   ✗ SIN source_url guardada\n'); sinUrl++; continue; }
    console.log(`   ${url}`);

    const r = await get(url);
    const html = String(r.data || '');
    if (r.status >= 400 || html.length < 500) {
      console.log(`   ✗ la página responde ${r.status} (${html.length} B)\n`);
      paginaMuerta++;
      continue;
    }

    // Lo que ve el scraper real.
    const detalle = await RealScraperService.scrapeFuegocineDetail(url).catch((e: any) => {
      console.log(`   ! scrapeFuegocineDetail lanzó: ${e.message?.slice(0, 60)}`);
      return null;
    });
    const nServidores = detalle?.servers?.length ?? 0;

    // Lo que hay en el HTML, a ojo.
    const iframes = [...new Set(html.match(/<iframe[^>]+src=["']([^"']+)["']/g) || [])].length;
    const enlacesReproductor = [...new Set(html.match(/(?:repfuegocinefree\.blogspot|upns|waaw|vidhide|emturbovid|ok\.ru|unlimplay|gscdn)[\w./?=&-]*/g) || [])];

    console.log(`   scraper saca: ${nServidores} servidores · iframes en el HTML: ${iframes} · pistas de reproductor: ${enlacesReproductor.length}`);
    if (enlacesReproductor.length) console.log(`      ${enlacesReproductor.slice(0, 3).join('\n      ')}`);

    if (nServidores > 0) { console.log('   ✓ AHORA SÍ los saca (la ficha está sin re-resolver)\n'); siHay++; }
    else if (enlacesReproductor.length) { console.log('   ✗ HAY enlaces en el HTML y el scraper no los ve\n'); scraperCiego++; }
    else { console.log('   · su página no publica enlaces\n'); paginaMuerta++; }
  }

  console.log('─────────────────────────────');
  console.log(`  sin source_url guardada        ${sinUrl}`);
  console.log(`  la página no publica enlaces   ${paginaMuerta}`);
  console.log(`  el scraper NO ve los que hay   ${scraperCiego}   <- aquí hay código que arreglar`);
  console.log(`  los saca (solo falta repasar)  ${siHay}   <- aquí solo falta re-resolver`);
})();
