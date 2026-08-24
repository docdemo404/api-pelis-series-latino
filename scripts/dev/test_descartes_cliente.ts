/**
 * BANCO DE PRUEBAS DEL REPARTO DE DESCARTES.
 *
 * `paraElCliente` recorta por dos motivos distintos y `descartesDelCliente` los separa. Lo que
 * aquí se comprueba es lo único que puede romperse en silencio: que la SUMA de los dos motivos
 * siga siendo exactamente lo que `paraElCliente` deja fuera. Si un día se añade un tercer recorte
 * al filtro y no se refleja en el reparto, el descuadre aparece aquí y no en un diagnóstico
 * equivocado seis meses después.
 *
 *   npx tsx scripts/dev/test_descartes_cliente.ts
 */
import { descartesDelCliente, paraElCliente } from '../../src/services/streamSorter';
import { ServerOption } from '../../src/types';

const ahora = new Date().toISOString();
const viejo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

const sv = (p: Partial<ServerOption>): ServerOption => ({
  id: 'x', name: 'x', quality: '', language: '', status: 'online', ...p,
} as ServerOption);

const casos: Array<{ nombre: string; entrada: ServerOption[]; publica: number; sinSello: number; sinVideo: number }> = [
  {
    nombre: 'el caso real: manual sellado + moviedays sellado',
    entrada: [
      sv({ id: 'manual', source_id: 'manual', direct_stream: 'https://video.gumlet.io/a/b/main.m3u8', direct_mode: 'public', verified_at: ahora }),
      sv({ id: 'md', source_id: 'moviedays', direct_stream: 'https://api/stream/direct?e=x', verified_at: ahora }),
    ],
    publica: 2, sinSello: 0, sinVideo: 0,
  },
  {
    nombre: 'el fallo reportado: al manual le caducó el sello',
    entrada: [
      sv({ id: 'manual', source_id: 'manual', direct_stream: 'https://video.gumlet.io/a/b/main.m3u8', direct_mode: 'public', verified_at: viejo }),
      sv({ id: 'md', source_id: 'moviedays', direct_stream: 'https://api/stream/direct?e=x', verified_at: ahora }),
    ],
    publica: 1, sinSello: 1, sinVideo: 0,
  },
  {
    nombre: 'un embed no cuenta como sello caducado',
    entrada: [
      sv({ id: 'emb', embed_url: 'https://host/e/abc' }),
      sv({ id: 'md', source_id: 'moviedays', direct_stream: 'https://api/stream/direct?e=x', verified_at: ahora }),
    ],
    publica: 1, sinSello: 0, sinVideo: 1,
  },
  {
    nombre: 'los muertos no entran en ningún motivo',
    entrada: [
      sv({ id: 'muerto', status: 'offline', direct_stream: 'https://a/b.mp4', verified_at: ahora }),
      sv({ id: 'md', direct_stream: 'https://api/stream/direct?e=x', verified_at: ahora }),
    ],
    publica: 1, sinSello: 0, sinVideo: 0,
  },
  { nombre: 'lista vacía', entrada: [], publica: 0, sinSello: 0, sinVideo: 0 },
];

let fallos = 0;
for (const c of casos) {
  const d = descartesDelCliente(c.entrada);
  const vivos = c.entrada.filter(s => s.status !== 'offline').length;
  const ok =
    d.publicables.length === c.publica &&
    d.sinSelloVigente === c.sinSello &&
    d.sinVideoDirecto === c.sinVideo &&
    // La invariante que de verdad importa: los dos motivos suman lo que el filtro deja fuera.
    d.sinSelloVigente + d.sinVideoDirecto === vivos - paraElCliente(c.entrada).length;
  if (!ok) fallos++;
  console.log(
    `${ok ? 'OK  ' : 'FALLA'}  ${c.nombre}\n` +
    `        publica=${d.publicables.length} (esperado ${c.publica})  ` +
    `sinSello=${d.sinSelloVigente} (${c.sinSello})  sinVideo=${d.sinVideoDirecto} (${c.sinVideo})`
  );
}
console.log(`\n${casos.length - fallos}/${casos.length} bien`);
process.exit(fallos ? 1 : 0);
