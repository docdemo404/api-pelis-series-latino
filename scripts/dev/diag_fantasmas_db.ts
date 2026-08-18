import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { fichaReproducible, paraElCliente } from '../../src/services/streamSorter';

/** ¿Cuántas fichas publicadas NO entregan un solo servidor al cliente? */
async function main() {
  const cuenta = async (label: string, build: (q: any) => any) => {
    const { count, error } = await build(supabase.from('media_items').select('id', { count: 'exact', head: true }));
    console.log(label.padEnd(52), error ? `ERROR ${error.message}` : count);
  };

  await cuenta('total filas', (q: any) => q);
  await cuenta('has_streams = true', (q: any) => q.eq('has_streams', true));
  await cuenta('has_streams = false', (q: any) => q.eq('has_streams', false));
  await cuenta('has_streams NULL', (q: any) => q.is('has_streams', null));
  await cuenta('PUBLICABLES (has_streams+poster)', (q: any) => q.eq('has_streams', true).not('poster', 'is', null));
  await cuenta('  · de esas, movies', (q: any) => q.eq('has_streams', true).not('poster', 'is', null).eq('type', 'movie'));
  await cuenta('  · de esas, series', (q: any) => q.eq('has_streams', true).not('poster', 'is', null).eq('type', 'tvseries'));

  // Muestra real: ¿qué entregaría paraElCliente hoy?
  const muestra = 1500;
  const { data, error } = await supabase
    .from('media_items')
    .select('id,title,type,servers,seasons,has_streams,streams_checked_at')
    .eq('has_streams', true)
    .not('poster', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(muestra);

  if (error || !data) { console.log('muestra ERROR', error?.message); return; }

  let vacias = 0, conAlgo = 0;
  const ejemplos: string[] = [];
  const porTipo: Record<string, { vacias: number; total: number }> = {};
  for (const row of data as any[]) {
    const t = row.type || '?';
    porTipo[t] = porTipo[t] || { vacias: 0, total: 0 };
    porTipo[t].total++;
    const ok = fichaReproducible(row);
    if (ok) conAlgo++;
    else {
      vacias++; porTipo[t].vacias++;
      if (ejemplos.length < 25) {
        const srv = (row.servers || []).length;
        const eps = (row.seasons || []).reduce((a: number, s: any) => a + (s.episodes || []).length, 0);
        const conDirecto = (row.servers || []).filter((s: any) => s?.direct_stream).length;
        const verificados = (row.servers || []).filter((s: any) => s?.verified_at).length;
        ejemplos.push(`${row.type}\t${row.title}\tsrv=${srv} directo=${conDirecto} verif=${verificados} eps=${eps}\tchecked=${row.streams_checked_at || '-'}`);
      }
    }
  }

  console.log(`\nMUESTRA de ${data.length} fichas publicadas (has_streams=true + poster):`);
  console.log(`  entregan algo al cliente : ${conAlgo}`);
  console.log(`  FANTASMAS (0 servidores) : ${vacias}  (${((vacias / data.length) * 100).toFixed(1)}%)`);
  for (const [t, v] of Object.entries(porTipo)) {
    console.log(`    ${t.padEnd(10)} ${v.vacias}/${v.total} fantasmas`);
  }
  console.log('\nEjemplos:');
  ejemplos.forEach(e => console.log('  ' + e));

  // ¿Cuántas serían reproducibles si NO se exigiera el sello de 6 h?
  let sinExigirSello = 0;
  for (const row of data as any[]) {
    const tieneDirecto = (list: any[]) => (list || []).some((s: any) => s?.direct_stream && s.status !== 'offline');
    const eps = (row.seasons || []).some((s: any) => (s.episodes || []).some((e: any) => tieneDirecto(e.servers)));
    const ok = row.type === 'tvseries' ? eps : (tieneDirecto(row.servers) || eps);
    if (ok) sinExigirSello++;
  }
  console.log(`\n  con directo (SIN exigir verified_at<6h): ${sinExigirSello}/${data.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
