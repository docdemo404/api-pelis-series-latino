import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient, USER_AGENT } from '../../src/utils/httpClient';
const API = 'https://api-pelis-series-latino-gilt.vercel.app';
const ID = process.argv[2] || '2025-11-star-wars-episodio-v-el-imperio-html';
const get = (u: string) => httpClient.get(u, { headers: { 'User-Agent': USER_AGENT }, timeout: 60000, responseType: 'text', transformResponse: [(d: unknown) => d], validateStatus: () => true } as any);
(async () => {
  const antes = (await supabase.from('media_items').select('has_streams,streams_updated_at,streams_checked_at,servers').eq('id', ID).maybeSingle()).data as any;
  console.log(`ANTES  has_streams=${antes?.has_streams} updated=${String(antes?.streams_updated_at).slice(0,19)} servidores=${(antes?.servers??[]).length}`);
  const r = await get(`${API}/api/v1/media/${encodeURIComponent(ID)}/streams`);
  let n = 0; try { const j = JSON.parse(String(r.data||'{}')); n = (j?.data?.servers ?? j?.servers ?? []).length; } catch {}
  console.log(`streams → http=${r.status}  ${n} servidor(es)`);
  const desp = (await supabase.from('media_items').select('has_streams,streams_updated_at').eq('id', ID).maybeSingle()).data as any;
  console.log(`DESPUES has_streams=${desp?.has_streams} updated=${String(desp?.streams_updated_at).slice(0,19)}`);
  console.log(`¿escribió? ${antes?.streams_updated_at !== desp?.streams_updated_at ? 'SI' : 'NO — no pasa por persistStreams'}`);
  const s = await get(`${API}/api/v1/search?q=${encodeURIComponent('imperio contraataca')}`);
  let sale = false; try { const j = JSON.parse(String(s.data||'{}')); sale = JSON.stringify(j).includes(ID); } catch {}
  console.log(`¿sigue en la búsqueda? ${sale ? 'SI' : 'NO'}`);
})();
