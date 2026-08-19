import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { paraElCliente } from '../../src/services/streamSorter';
(async () => {
  const ids = process.argv.slice(2);
  for (const id of ids) {
    const { data } = await supabase.from('media_items')
      .select('id,title,has_streams,streams_checked_at,streams_updated_at,servers,seasons').eq('id', id).maybeSingle();
    if (!data) { console.log(`${id}: no existe`); continue; }
    const d: any = data;
    const srv = d.servers ?? [];
    const publicables = paraElCliente(srv).length;
    const conDirecto = srv.filter((s: any) => s?.direct_stream && s.status !== 'offline').length;
    const sellados = srv.filter((s: any) => s?.verified_at && Date.now() - Date.parse(s.verified_at) < 6*3600*1000).length;
    console.log(`\n«${d.title}»`);
    console.log(`   has_streams=${d.has_streams}  sello_fila=${String(d.streams_checked_at).slice(0,19)}`);
    console.log(`   servidores=${srv.length}  con directo=${conDirecto}  sellados<6h=${sellados}  PUBLICABLES=${publicables}`);
  }
})();
