/** Sobre fichas ANUNCIADAS al azar: ¿cuántas fallan a la primera y funcionan a la segunda? */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
const API = 'https://api-pelis-series-latino-gilt.vercel.app';
const N = Number((process.argv.find(a=>a.startsWith('--n='))||'').split('=')[1] || 14);
const get = (u: string) => httpClient.get(u, { headers: { 'User-Agent': USER_AGENT }, timeout: 90000, responseType: 'text', transformResponse: [(d: unknown) => d], validateStatus: () => true } as any);
const n = (r: any) => { try { const j = JSON.parse(String(r.data||'{}')); return (j?.data?.servers ?? j?.servers ?? []).length; } catch { return -1; } };
(async () => {
  const { data } = await supabase.from('media_items')
    .select('id,title').eq('has_streams', true).eq('type','movie')
    .gt('streams_checked_at', new Date(Date.now()-6*3600*1000).toISOString())
    .order('rating', { ascending: false }).limit(200);
  const muestra = (data ?? []).sort(() => Math.random()-0.5).slice(0, N);
  let soloSegunda = 0, ambasCero = 0, ok = 0; const lentas: number[] = [];
  for (const f of muestra as any[]) {
    const t1 = Date.now(); const a = await get(`${API}/api/v1/media/${encodeURIComponent(f.id)}/streams`); const ms1 = Date.now()-t1;
    const b = await get(`${API}/api/v1/media/${encodeURIComponent(f.id)}/streams`);
    const s1 = n(a), s2 = n(b); lentas.push(ms1);
    let marca = '';
    if (s1 === 0 && s2 > 0) { soloSegunda++; marca = '← FALLA LA 1ª, VA LA 2ª'; }
    else if (s1 === 0 && s2 === 0) { ambasCero++; marca = '← muda las dos'; }
    else ok++;
    console.log(`${String(f.title).slice(0,34).padEnd(34)} 1ª:${String(s1).padStart(2)} (${String(ms1).padStart(5)}ms)  2ª:${String(s2).padStart(2)}  ${marca}`);
  }
  lentas.sort((x,y)=>x-y);
  console.log(`\n  bien a la primera      ${ok}/${muestra.length}`);
  console.log(`  SOLO al segundo intento ${soloSegunda}/${muestra.length}`);
  console.log(`  mudas las dos veces    ${ambasCero}/${muestra.length}`);
  console.log(`  1ª llamada: mediana ${lentas[Math.floor(lentas.length/2)]} ms · peor ${lentas[lentas.length-1]} ms`);
})();
