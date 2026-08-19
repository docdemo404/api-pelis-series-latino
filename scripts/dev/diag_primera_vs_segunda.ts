/** ¿Falla solo la PRIMERA llamada? Pide /streams dos veces seguidas y compara. */
import 'dotenv/config';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
const API = 'https://api-pelis-series-latino-gilt.vercel.app';
const get = (u: string) => httpClient.get(u, { headers: { 'User-Agent': USER_AGENT }, timeout: 90000, responseType: 'text', transformResponse: [(d: unknown) => d], validateStatus: () => true } as any);
const n = (r: any) => { try { const j = JSON.parse(String(r.data||'{}')); return (j?.data?.servers ?? j?.servers ?? []).length; } catch { return -1; } };
(async () => {
  const ids = process.argv.slice(2);
  let mejoran = 0;
  for (const id of ids) {
    const t1 = Date.now(); const a = await get(`${API}/api/v1/media/${encodeURIComponent(id)}/streams`); const ms1 = Date.now()-t1;
    const t2 = Date.now(); const b = await get(`${API}/api/v1/media/${encodeURIComponent(id)}/streams`); const ms2 = Date.now()-t2;
    const s1 = n(a), s2 = n(b);
    if (s1 === 0 && s2 > 0) mejoran++;
    console.log(`${id.slice(0,44).padEnd(44)} 1ª: ${String(s1).padStart(2)} srv (${String(ms1).padStart(5)} ms)   2ª: ${String(s2).padStart(2)} srv (${String(ms2).padStart(5)} ms)  ${s1===0&&s2>0?'← FALLA SOLO LA PRIMERA':''}`);
  }
  console.log(`\n${mejoran}/${ids.length} funcionan solo al segundo intento`);
})();
