/** ¿Cuántas fichas tienen ya un servidor en modo `public` verificado? */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
(async () => {
  let ultimoId = '', filas = 0, conPublic = 0, urls = 0;
  const porHost: Record<string, number> = {};
  for (;;) {
    const { data } = await supabase.from('media_items').select('id,servers').gt('id', ultimoId).order('id').limit(500);
    if (!data?.length) break;
    ultimoId = (data[data.length-1] as any).id;
    for (const r of data as any[]) {
      filas++;
      const pub = (r.servers ?? []).filter((s: any) => s?.direct_mode === 'public' && s?.direct_stream);
      if (!pub.length) continue;
      conPublic++; urls += pub.length;
      for (const s of pub) { try { const h = new URL(s.direct_stream).hostname.replace(/^www\./,''); porHost[h]=(porHost[h]||0)+1; } catch {} }
    }
    process.stderr.write(`  …${filas}\r`);
  }
  console.log(`\nfilas totales           ${filas}`);
  console.log(`con url PERMANENTE      ${conPublic}   (${((conPublic/filas)*100).toFixed(1)}%)`);
  console.log(`urls permanentes        ${urls}  (media ${(urls/Math.max(conPublic,1)).toFixed(1)} por ficha)`);
  console.log(`\npor host:`);
  for (const [h,n] of Object.entries(porHost).sort((a,b)=>b[1]-a[1]).slice(0,10)) console.log(`   ${String(n).padStart(5)}  ${h}`);
})();
