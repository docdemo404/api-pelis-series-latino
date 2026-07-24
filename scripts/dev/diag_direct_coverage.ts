import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';

/**
 * Cobertura de vídeo directo ya PERSISTIDA en el catálogo, desglosada por host.
 *
 * Es la métrica que dice si merece la pena escribir el extractor de un host más: un host con
 * muchos servidores y cero directos es candidato; uno con pocos, no.
 *
 *   npx ts-node scripts/dev/diag_direct_coverage.ts [muestra]
 */
async function main() {
  const sample = parseInt(process.argv[2] || '1000', 10);
  const { data, error } = await getSupabaseAdmin()
    .from('media_items')
    .select('id,servers')
    .not('servers', 'is', null)
    .neq('servers', '[]')
    .limit(sample);

  if (error) return console.error('error:', error.message);

  const rows = data || [];
  const porHost = new Map<string, { total: number; directos: number }>();
  let fichasConDirecto = 0;
  let servidores = 0;
  let directos = 0;

  for (const row of rows) {
    const list = (row.servers || []) as any[];
    if (list.some(s => s?.direct_stream)) fichasConDirecto++;
    for (const s of list) {
      servidores++;
      let host = '(desconocido)';
      try {
        host = new URL(s.embed_url).hostname.replace(/^www\./, '');
      } catch {}
      const acc = porHost.get(host) || { total: 0, directos: 0 };
      acc.total++;
      if (s?.direct_stream) {
        acc.directos++;
        directos++;
      }
      porHost.set(host, acc);
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? '  0%' : `${String(Math.round((a / b) * 100)).padStart(3)}%`);
  console.log(`\nFichas con enlaces: ${rows.length} · con vídeo directo: ${fichasConDirecto} (${pct(fichasConDirecto, rows.length)})`);
  console.log(`Servidores: ${servidores} · con vídeo directo: ${directos} (${pct(directos, servidores)})\n`);
  console.log('host                            servidores   directos');
  console.log('─'.repeat(58));
  for (const [host, acc] of [...porHost.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 18)) {
    console.log(`${host.slice(0, 30).padEnd(30)} ${String(acc.total).padStart(8)}   ${String(acc.directos).padStart(6)} ${pct(acc.directos, acc.total)}`);
  }
}

main().then(() => setTimeout(() => process.exit(0), 500).unref());
