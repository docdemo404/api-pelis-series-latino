import 'dotenv/config';
import { TmdbService } from '../../src/services/tmdbService';
import { supabase } from '../../src/services/supabaseService';
import { ContentType } from '../../src/types';

/** Variantes regionales del MISMO título: todas deberían converger en un solo tmdb_id. */
const GROUPS: Array<{ label: string; esperado?: number; titles: Array<[string, ContentType, string?]> }> = [
  {
    label: 'Home Alone (1990)', esperado: 771,
    titles: [['Home Alone', 'movie', '1990'], ['Solo en casa', 'movie', '1990'], ['Mi pobre angelito', 'movie', '1990']]
  },
  {
    // "Zootopia+" / "Zootrópolis+" es una SERIE derivada: entidad propia, no una variante
    // regional de la película, así que no debe converger con ella.
    label: 'Zootopia (2016)', esperado: 269149,
    titles: [['Zootopia', 'movie', '2016'], ['Zootrópolis', 'movie', '2016']]
  },
  {
    label: 'Zootopia 2 (2025)',
    titles: [['Zootopia 2', 'movie', '2025'], ['Zootrópolis 2', 'movie', '2025']]
  },
  {
    label: 'The Rise of Gru (2022)', esperado: 438148,
    titles: [['Minions: Nace un villano', 'movie', '2022'], ['Minions: El origen de Gru', 'movie', '2022']]
  },
  {
    label: 'Despicable Me (2010)', esperado: 20352,
    titles: [['Mi villano favorito', 'movie', '2010'], ['Gru, mi villano favorito', 'movie', '2010']]
  },
  {
    // OJO: "Rápidos y furiosos" NO es una variante de la de 2001 — es el título es-MX
    // oficial de la CUARTA entrega (2009, tmdb 13804); la primera se llama "Rápido y
    // furioso" en singular. El nombre en plural designa además a la saga entera, así que
    // aquí solo converge la pareja que de verdad es el mismo título.
    label: 'The Fast and the Furious (2001)', esperado: 9799,
    titles: [['A todo gas', 'movie', '2001'], ['Rápido y furioso', 'movie', '2001']]
  },
  {
    // "El super fantasma" no está registrado en TMDB como título de Beetlejuice, así que
    // no hay dato con el que emparejarlo: quedarse sin match es el resultado correcto.
    label: 'Beetlejuice (1988)', esperado: 4011,
    titles: [['Beetlejuice', 'movie', '1988'], ['Bitelchús', 'movie', '1988']]
  }
];

(async () => {
  console.log('=== ¿Convergen las variantes regionales en el MISMO tmdb_id? ===\n');
  let groupsOk = 0;

  for (const g of GROUPS) {
    const ids: number[] = [];
    const lines: string[] = [];
    for (const [title, type, year] of g.titles) {
      const m = await TmdbService.resolveTmdb(title, type, year);
      ids.push(m.id);
      lines.push(`      ${m.matched ? 'OK ' : '-- '} "${title}" -> ${m.id} (score ${m.score.toFixed(2)})`);
    }
    const unique = Array.from(new Set(ids));
    const converge = unique.length === 1 && unique[0] > 0;
    const correcto = g.esperado ? unique[0] === g.esperado : true;
    if (converge && correcto) groupsOk++;
    console.log(`${converge && correcto ? '✅' : '❌'} ${g.label}${g.esperado ? ` (esperado ${g.esperado})` : ''}`);
    lines.forEach(l => console.log(l));
    if (!converge) console.log(`      → ${unique.length} ids distintos: ${unique.join(', ')} ⇒ FICHAS DUPLICADAS`);
    console.log('');
  }
  console.log(`Grupos que convergen: ${groupsOk}/${GROUPS.length}\n`);

  // Guardas de PRECISIÓN: unificar variantes regionales no puede degenerar en emparejar
  // cualquier cosa. Estos casos deben seguir comportándose como antes.
  console.log('=== Guardas de precisión ===');
  const guards: Array<[string, ContentType, string | undefined, boolean, string]> = [
    ['Vengadores Chiflados', 'movie', undefined, true, 'conserva SU ficha (parodia), no la de Avengers'],
    ['asdkjhasdkjhqwe zxcvbn', 'movie', undefined, false, 'no debe emparejar nada'],
    ['Gambling House', 'movie', '1950', true, 'la peli de 1950 sigue siendo ella misma']
  ];
  for (const [title, type, year, shouldMatch, nota] of guards) {
    const m = await TmdbService.resolveTmdb(title, type, year);
    const ok = m.matched === shouldMatch;
    console.log(`   ${ok ? '✅' : '❌'} "${title}" -> ${m.id} (score ${m.score.toFixed(2)}) — ${nota}`);
  }
  console.log('');

  // ¿Cuántas de esas variantes están REALMENTE en el catálogo como fichas separadas?
  console.log('=== Presencia en el catálogo ===');
  for (const needle of ['zootopia', 'zootropolis', 'solo en casa', 'mi pobre angelito', 'home alone', 'a todo gas', 'bitelchus']) {
    const { data } = await supabase
      .from('media_items')
      .select('id,tmdb_id,title')
      .ilike('title_normalized', `%${needle}%`)
      .limit(5);
    const found = (data || []).map(r => `${r.tmdb_id}:"${r.title}"`).join('  ') || '(ninguna)';
    console.log(`   ${needle.padEnd(20)} ${found}`);
  }
})();
