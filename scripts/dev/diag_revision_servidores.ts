import 'dotenv/config';
import { ServerOption } from '../../src/types';
import { revisarServidores, comprobarEmbed } from '../../src/services/playbackHealth';
import { sortServersBySourcePriority } from '../../src/services/streamSorter';

/**
 * ¿LA LISTA QUE SE ENTREGA EMPIEZA POR ALGO QUE REPRODUCE?
 *
 * `diag_playable.ts` responde "¿reproduce este enlace?" contra la API desplegada. Esto responde
 * la otra mitad, la que faltaba: dada la lista de servidores de una ficha, ¿qué hace la revisión
 * con ella? Quién baja, quién se queda y quién acaba de cabeza.
 *
 * Se ejecuta contra la API en producción para leer la ficha real, pero la revisión corre EN
 * LOCAL, que es lo que permite ver el veredicto y el motivo de cada servidor uno por uno.
 *
 *   npx ts-node scripts/dev/diag_revision_servidores.ts 2025-11-sin-salida-2025-html
 *   npx ts-node scripts/dev/diag_revision_servidores.ts <id> --todos
 */

const API = process.env.API_BASE || 'https://api-pelis-series-latino.vercel.app';

async function main(): Promise<void> {
  const id = process.argv[2];
  const todos = process.argv.includes('--todos');
  if (!id) {
    console.error('Uso: ts-node scripts/dev/diag_revision_servidores.ts <id-de-ficha> [--todos]');
    process.exit(1);
  }

  const res = await fetch(`${API}/api/v1/media/${encodeURIComponent(id)}/streams`);
  const json: any = await res.json();
  const servers: ServerOption[] = json?.data?.servers || [];
  if (servers.length === 0) {
    console.log(`Sin servidores para ${id}.`);
    return;
  }

  console.log(`\n"${json.data.title}" — ${servers.length} servidores tal y como los entrega la API\n`);
  const ordenados = sortServersBySourcePriority(servers);
  ordenados.forEach((s, i) => console.log(`  ${i} ${s.status.padEnd(7)} ${s.embed_url.slice(0, 76)}`));

  // La pasada REAL primero y en frío: es lo que se le suma a la respuesta del cliente, y
  // medirla después de haber sondeado a mano sería medir el caché en vez del coste.
  const inicio = Date.now();
  const revisados = sortServersBySourcePriority(await revisarServidores(ordenados, { presupuestoMs: 4000, maximo: 3 }));
  console.log(`\nLista revisada en frío — ${Date.now() - inicio} ms:\n`);
  revisados.forEach((s, i) => {
    const tipo = s.direct_stream ? 'directo' : 'embed  ';
    console.log(`  ${i} ${s.status.padEnd(7)} ${tipo} ${s.embed_url.slice(0, 68)}`);
  });
  console.log(`\nCabeza: ${revisados[0]?.status} · ${revisados[0]?.embed_url}`);

  // Uno a uno, para ver el motivo de cada uno. La revisión de verdad no llega hasta aquí:
  // para en cuanto la cabeza es fiable.
  console.log('\nComprobación individual (baja hasta el segmento):\n');
  for (const s of (todos ? ordenados : ordenados.slice(0, 6))) {
    if (!s.direct_stream) {
      console.log(`  ·  sin vídeo directo         ${s.embed_url.slice(0, 60)}`);
      continue;
    }
    const t = Date.now();
    const c = await comprobarEmbed(s.embed_url, { limite: Date.now() + 15000 });
    const marca = c.veredicto === 'muerto' ? '✗' : c.veredicto === 'vivo' ? '✓' : '?';
    const motivo = c.motivo ? `  (${c.motivo})` : '';
    console.log(`  ${marca}  ${c.veredicto.padEnd(11)} ${String(Date.now() - t).padStart(5)} ms  ${s.embed_url.slice(0, 56)}${motivo}`);
  }
  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
