/**
 * Las reglas de «cuándo hay derecho a decidir», fijadas con los casos REALES que las rompieron.
 *
 * Cada aserción de aquí abajo es un daño que ya ocurrió en producción, no un caso inventado.
 *
 *   npx tsx scripts/dev/test_veredicto_disponibilidad.ts
 */
import { veredictoDisponibilidad } from '../../src/services/streamSorter';

let fallos = 0;
const ok = (d: string, real: unknown, esp: unknown) => {
  const bien = real === esp;
  if (!bien) fallos++;
  console.log(`   ${bien ? '✓' : '✗'} ${d}${bien ? '' : `  (esperado ${esp}, salió ${real})`}`);
};

const ahora = new Date().toISOString();
const vivo = { direct_stream: '/x', status: 'online', verified_at: ahora } as any;
const sinSello = { direct_stream: '/x', status: 'online' } as any;
const cap = (servers: any[], checked?: boolean) => ({ servers, ...(checked ? { checked_at: ahora } : {}) });
const serie = (eps: any[]) => ({ type: 'tvseries', servers: [], seasons: [{ episodes: eps }] });

console.log('\n── Encontrar algo basta para decir que SÍ');
ok('película con servidor verificado', veredictoDisponibilidad({ type: 'movie', servers: [vivo] }, 'parcial'), true);
ok('serie con un capítulo que se ve', veredictoDisponibilidad(serie([cap([vivo])]), 'parcial'), true);

console.log('\n── No encontrar nada NO basta, si no se ha mirado todo');
// El daño: 789 series visibles cayeron a 534 porque el primer capítulo vacío enterraba la serie.
ok('1 capítulo comprobado vacío, 25 sin mirar', veredictoDisponibilidad(serie([cap([], true), cap([]), cap([])]), 'parcial'), undefined);
ok('todos comprobados y vacíos', veredictoDisponibilidad(serie([cap([], true), cap([], true)]), 'parcial'), false);
// El daño: la migración 007 escondió ~700 series calculando sobre capítulos nunca resueltos.
ok('ningún capítulo comprobado', veredictoDisponibilidad(serie([cap([]), cap([])]), 'parcial'), undefined);
ok('serie sin árbol de temporadas', veredictoDisponibilidad({ type: 'tvseries', servers: [], seasons: [] }, 'parcial'), undefined);

console.log('\n── Alcance');
ok('no se pudo preguntar a nadie', veredictoDisponibilidad({ type: 'movie', servers: [] }, 'nada'), undefined);
ok('repaso completo y vacío', veredictoDisponibilidad({ type: 'movie', servers: [] }, 'todo'), false);
ok('repaso completo con algo', veredictoDisponibilidad({ type: 'movie', servers: [vivo] }, 'todo'), true);

console.log('\n── Y el criterio que ya estaba');
ok('servidor SIN verificar no cuenta', veredictoDisponibilidad({ type: 'movie', servers: [sinSello] }, 'todo'), false);
// El daño: los servidores de nivel serie hacían visible una serie que no podía enseñar capítulos.
ok('serie: los servidores de ficha no cuentan', veredictoDisponibilidad({ type: 'tvseries', servers: [vivo], seasons: [{ episodes: [cap([], true)] }] }, 'todo'), false);
ok('película: los suyos sí cuentan', veredictoDisponibilidad({ type: 'movie', servers: [vivo] }, 'todo'), true);

console.log(fallos === 0 ? '\n✅ todo correcto\n' : `\n❌ ${fallos} fallo(s)\n`);
process.exit(fallos === 0 ? 0 : 1);
