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

console.log('\n── Una PELÍCULA sí se puede concluir en el camino de una petición');
/*
 * El daño: entre el 8 % y el 33 % de lo que se anunciaba en producción no entregaba un solo
 * servidor. La petición sondeaba la lista entera, la dejaba vacía… y devolvía `undefined`, así que
 * el veredicto no se escribía en ninguna parte y el título seguía en la portada, en el catálogo y
 * en el buscador. Medido con «La Máscara»: seis servidores, y el único con vídeo directo
 * contestando 403.
 *
 * La regla: en una película, «parcial» solo puede significar «quedaron servidores sin sondear».
 * Si no queda ninguno, se ha mirado todo lo que había — y eso es tan concluyente como el repaso
 * completo. La cautela que nació con las series se queda en las series.
 */
const muerto = { embed_url: 'https://x/1', status: 'offline' } as any;
const soloEmbed = { embed_url: 'https://x/2', status: 'online' } as any;
ok('película con toda la lista sondeada y caída', veredictoDisponibilidad({ type: 'movie', servers: [muerto, muerto] }, 'parcial'), false);
ok('película que solo puede ofrecer iframes', veredictoDisponibilidad({ type: 'movie', servers: [soloEmbed] }, 'parcial'), false);
ok('película sin un solo servidor', veredictoDisponibilidad({ type: 'movie', servers: [] }, 'parcial'), false);
// Y lo que NO se puede concluir: con el presupuesto agotado quedan directos sin mirar.
ok('película con un directo SIN sondear', veredictoDisponibilidad({ type: 'movie', servers: [muerto, sinSello] }, 'parcial'), undefined);
ok('película sin poder preguntar a nadie', veredictoDisponibilidad({ type: 'movie', servers: [muerto] }, 'nada'), undefined);

console.log('\n── Y el criterio que ya estaba');
ok('servidor SIN verificar no cuenta', veredictoDisponibilidad({ type: 'movie', servers: [sinSello] }, 'todo'), false);
// El daño: los servidores de nivel serie hacían visible una serie que no podía enseñar capítulos.
ok('serie: los servidores de ficha no cuentan', veredictoDisponibilidad({ type: 'tvseries', servers: [vivo], seasons: [{ episodes: [cap([], true)] }] }, 'todo'), false);
ok('película: los suyos sí cuentan', veredictoDisponibilidad({ type: 'movie', servers: [vivo] }, 'todo'), true);

console.log(fallos === 0 ? '\n✅ todo correcto\n' : `\n❌ ${fallos} fallo(s)\n`);
process.exit(fallos === 0 ? 0 : 1);
