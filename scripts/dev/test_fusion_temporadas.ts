/**
 * Banco de pruebas de `fusionarTemporadas`: la función con la que este proyecto junta lo que sabe
 * de una serie por dos caminos distintos (el crawl al escribir, la API al resolver un capítulo y
 * la reparación al fundir un duplicado en su ficha oficial).
 *
 * Las tres cosas que tiene que cumplir, y las tres han fallado alguna vez:
 *   · no perder capítulos (reemplazar en vez de mezclar dejaba la serie con un episodio),
 *   · acumular los servidores de las dos fuentes en el capítulo que existe en las dos,
 *   · NO TOCAR lo que le pasan, para que quien llama pueda comparar «antes» y «después» y saber
 *     si merece la pena escribir. Mutando la entrada, esa comparación dice siempre «no suma».
 */
import { fusionarTemporadas } from '../../src/services/catalogService';

let fallos = 0;
const ok = (d: string, real: unknown, esp: unknown) => {
  const bien = JSON.stringify(real) === JSON.stringify(esp);
  if (!bien) fallos++;
  console.log(`   ${bien ? '✓' : '✗'} ${d}${bien ? '' : `  (esperado ${JSON.stringify(esp)}, salió ${JSON.stringify(real)})`}`);
};

const sv = (url: string, fuente: string) => ({ direct_stream: url, source_id: fuente });
const temporada = (n: number, eps: any[]) => ({ season_number: n, episodes: eps });
const cap = (n: number, servers: any[] = []) => ({ episode_number: n, servers });

const capitulos = (temps: any[]) => temps.flatMap((t: any) => (t.episodes || []).map((e: any) => `${t.season_number}x${e.episode_number}`));
const enlaces = (temps: any[]) => temps.reduce((n: number, t: any) => n + (t.episodes || []).reduce((m: number, e: any) => m + (e.servers || []).length, 0), 0);

console.log('\n── No se pierde nada de lo que ya estaba');
const previas = [temporada(1, [cap(1, [sv('/md1', 'moviedays')]), cap(2, [sv('/md2', 'moviedays')])])];
const nuevas = [temporada(1, [cap(1, [sv('/fc1', 'fuegocine')]), cap(3, [sv('/fc3', 'fuegocine')])])];
const fundidas = fusionarTemporadas(previas, nuevas);
ok('los capítulos de las dos listas', capitulos(fundidas), ['1x1', '1x2', '1x3']);
ok('el capítulo común acumula los dos servidores', enlaces(fundidas), 4);
ok('una temporada que solo trae la nueva se añade',
  capitulos(fusionarTemporadas(previas, [temporada(2, [cap(1)])])), ['1x1', '1x2', '2x1']);

console.log('\n── Y la lista de entrada se queda como estaba');
// El daño: la reparación comparaba el resultado con la lista previa para decidir si escribir, y
// como la fusión se la había mutado por debajo, «no suma nada» y los servidores de la fuente
// absorbida no llegaban a guardarse nunca.
ok('las previas conservan sus capítulos', capitulos(previas), ['1x1', '1x2']);
ok('las previas conservan SUS servidores, no los de la fusión', enlaces(previas), 2);
ok('el resultado sí los tiene todos', enlaces(fundidas), 4);

console.log('\n── Listas vacías');
ok('sin nuevas se devuelve lo que había', capitulos(fusionarTemporadas(previas, [])), ['1x1', '1x2']);
ok('sin previas se devuelve lo nuevo', capitulos(fusionarTemporadas([], nuevas)), ['1x1', '1x3']);

console.log(fallos === 0 ? '\n✅ todo correcto' : `\n❌ ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
