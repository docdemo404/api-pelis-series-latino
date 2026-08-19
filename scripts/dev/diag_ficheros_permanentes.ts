/**
 * ¿CUÁNTAS FICHAS TIENEN UN FICHERO DE VÍDEO CON URL PERMANENTE?
 *
 * La medición anterior se engañó y conviene dejarlo escrito: daba por «permanente» la url de la
 * PÁGINA del reproductor (`vidhideplus.com/v/abc`), que efectivamente no caduca… porque no es un
 * vídeo, es una web. El vídeo que hay detrás se firma con caducidad en cada visita.
 *
 * Lo que sí es un fichero permanente son los envoltorios de FuegoCine, que llevan la dirección
 * real dentro de un parámetro: `?link=https://pixeldrain.com/api/file/XXXX`. Ahí la url ES el
 * fichero, sin firma y sin caducidad — se puede pegar en un navegador dentro de un año.
 *
 * Esto cuenta esas, que son las únicas que sirven para una hoja de cálculo de «título → url».
 *
 *   npx ts-node -T scripts/dev/diag_ficheros_permanentes.ts [--csv]
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { hasVolatileToken } from '../../src/scrapers/directStream';

const CSV = process.argv.includes('--csv');

/** Hosts cuya url ES el fichero: se piden y devuelven bytes de vídeo, sin firma. */
const FICHERO_DIRECTO = [
  /pixeldrain\.com\/api\/file\//i,
  /archive\.org\/download\//i,
  /1a-\d+\.com\/video\//i,
  /cdn\.rumble\.cloud\/video\//i,
  /remux\.unlimplay\.com\/remux/i,
  /\.(mp4|mkv|webm)(\?|$)/i,
];

/** La url que el envoltorio lleva dentro, en cualquiera de sus parámetros. */
function urlEnvuelta(embed: string): string | null {
  try {
    const q = new URL(embed).searchParams;
    for (const [, v] of q) {
      if (!v) continue;
      const cand = /^https?:\/\//i.test(v) ? v : (/^[\w.-]+\.[a-z]{2,}\//i.test(v) ? `https://${v}` : '');
      if (cand) return cand;
    }
  } catch { /* nada */ }
  return null;
}

const hostDe = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '(ilegible)'; } };

(async () => {
  let ultimoId = '';
  let filas = 0, conFichero = 0;
  const porHost: Record<string, number> = {};
  const hoja: Array<[string, string, string]> = [];

  for (;;) {
    const { data, error } = await supabase.from('media_items')
      .select('id,title,type,release_date,servers').gt('id', ultimoId).order('id').limit(500);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    ultimoId = (data[data.length - 1] as any).id;

    for (const r of data as any[]) {
      filas++;
      let encontrada: string | null = null;
      for (const s of (r.servers ?? [])) {
        if (s?.status === 'offline') continue;
        const embed = String(s?.embed_url || '');
        // La dirección real puede ser el propio embed o la que lleva dentro un envoltorio.
        for (const cand of [urlEnvuelta(embed), embed]) {
          if (!cand) continue;
          if (!FICHERO_DIRECTO.some(re => re.test(cand))) continue;
          if (hasVolatileToken(cand)) continue;   // firma o caducidad dentro: no vale
          encontrada = cand;
          break;
        }
        if (encontrada) break;
      }
      if (!encontrada) continue;
      conFichero++;
      porHost[hostDe(encontrada)] = (porHost[hostDe(encontrada)] || 0) + 1;
      hoja.push([String(r.title), String(r.release_date || '').slice(0, 4), encontrada]);
    }
    process.stderr.write(`  …${filas}\r`);
  }

  if (CSV) {
    console.log('titulo,anio,url');
    for (const [t, a, u] of hoja) console.log(`"${t.replace(/"/g, '""')}",${a},${u}`);
    return;
  }

  console.log(`\nSobre ${filas} fichas:`);
  console.log(`   con FICHERO de vídeo de url permanente   ${conFichero}  (${((conFichero / filas) * 100).toFixed(1)}%)`);
  console.log(`\n   Por host:`);
  for (const [h, n] of Object.entries(porHost).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`      ${String(n).padStart(5)}  ${h}`);
  }
  console.log(`\n   Ejemplos (así se vería la hoja):`);
  for (const [t, a, u] of hoja.slice(0, 10)) {
    console.log(`      ${t.slice(0, 32).padEnd(32)} ${a}  ${u.slice(0, 84)}`);
  }
  console.log(`\n   Para sacarla entera:  npx ts-node -T scripts/dev/diag_ficheros_permanentes.ts --csv > catalogo.csv`);
})();
