import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import { paraElCliente } from '../../src/services/streamSorter';

/** Qué capítulos de una serie NO se anuncian, y qué se sabe de ellos. */
(async () => {
  const id = process.argv[2] || 'md-1396';
  const { data } = await getSupabaseAdmin()
    .from('media_items').select('id,title,seasons').eq('id', id).maybeSingle();
  if (!data) { console.log('no existe', id); process.exit(1); }

  const r = data as any;
  let total = 0, ok = 0;
  console.log(`«${r.title}» — capítulos que NO se anuncian:`);
  for (const t of (r.seasons || [])) {
    for (const e of (t?.episodes || [])) {
      total++;
      const pub = paraElCliente(e?.servers).length;
      if (pub > 0) { ok++; continue; }
      const crudos = (e?.servers || []).length;
      const estados = (e?.servers || []).map((sv: any) =>
        `${sv?.source_id}/${sv?.status}${sv?.verified_at ? '/sellado' : '/SIN SELLO'}${sv?.direct_stream ? '' : '/sin directo'}`);
      console.log(
        `  ${t.season_number}x${e.episode_number}`.padEnd(10),
        `«${e.name || ''}»`.slice(0, 34).padEnd(36),
        `servidores: ${crudos}`,
        crudos ? '· ' + estados.join(' · ') : '',
        `· checked_at: ${e.checked_at || 'nunca'}`);
    }
  }
  console.log(`\n${ok}/${total} anunciables · faltan ${total - ok}`);
  process.exit(0);
})();
