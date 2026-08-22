import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
(async () => {
  const db = getSupabaseAdmin();
  let from = 0, conManual: any[] = [], total = 0;
  for (;;) {
    const { data, error } = await db.from('media_items')
      .select('id,title,type,servers,seasons,has_streams,streams_checked_at,updated_at,streams_updated_at')
      .range(from, from + 499);
    if (error) { console.log('ERROR', error.message); break; }
    if (!data?.length) break;
    total += data.length;
    for (const r of data as any[]) {
      const ficha = (r.servers || []).filter((s: any) => String(s?.source_id).toLowerCase() === 'manual');
      const caps = (r.seasons || []).flatMap((t: any) => t.episodes || [])
        .flatMap((e: any) => (e.servers || []).filter((s: any) => String(s?.source_id).toLowerCase() === 'manual'));
      if (ficha.length || caps.length) conManual.push({ ...r, nManual: ficha.length, nManualCaps: caps.length });
    }
    if (data.length < 500) break;
    from += 500;
  }
  console.log(`filas totales: ${total} · con algún servidor manual: ${conManual.length}\n`);
  for (const r of conManual) {
    console.log(`  ${r.id} "${r.title}" ${r.type} | manual: ${r.nManual} en ficha, ${r.nManualCaps} en capítulos | has_streams=${r.has_streams}`);
    console.log(`      updated=${r.updated_at} streams_updated=${r.streams_updated_at} checked=${r.streams_checked_at}`);
  }
  process.exit(0);
})();
