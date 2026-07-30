/**
 * ¿A cuántas fichas les pasó lo de "Sin salida"?
 *
 * La fuente publica el título ORIGINAL de la película en su ficha de datos
 * (`data-original-title`). Cuando ese nombre no se parece a ninguno de los que tiene la ficha
 * guardada —ni al título, ni al original, ni a sus alias—, la fuente nos está diciendo que
 * adoptamos la película equivocada.
 *
 * Se descubrió con `2025-11-sin-salida-2025-html`: la página decía `data-original-title="Bunker"`
 * y `data-year="2025"`, y la ficha acabó siendo "Sin salida" (2024) de TMDB, con su póster y su
 * sinopsis. El vídeo era el bueno; la ficha entera, de otra película. El año, con un solo año de
 * diferencia, había bastado para dar el emparejamiento por respaldado y tapar el desmentido.
 *
 *   npx ts-node --transpile-only scripts/dev/probe_original_contradice.ts [--muestra=200] [--todas]
 */
import 'dotenv/config';
import { getSupabaseAdmin } from '../../src/services/supabaseService';
import * as cheerio from 'cheerio';
import { httpGetHtml, USER_AGENT } from '../../src/utils/httpClient';
import { similarity } from '../../src/services/tmdbService';

const db = getSupabaseAdmin();
const arg = (n: string, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const MUESTRA = Number(arg('muestra', '200'));
const TODAS = process.argv.includes('--todas');

/** Se acepta a partir de aquí: por debajo, el nombre que publica la fuente es OTRO nombre. */
const PARECIDO_MINIMO = 0.9;

async function detallesDeLaPagina(url: string): Promise<{ original?: string; year?: string } | null> {
  try {
    const res = await httpGetHtml(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d: unknown) => d],
    });
    if (res.status !== 200) return null;
    // Se lee con cheerio, IGUAL que el scraper de verdad. Con una expresion regular sobre el
    // HTML crudo este detector se inventaba problemas: `data-original-title="Pete's Dragon"` se
    // cortaba en el apostrofo y daba "Pete", y las entidades HTML (`Marley &amp; Me`) llegaban
    // sin decodificar. Nueve de cada diez avisos eran del detector, no del catalogo.
    const $ = cheerio.load(String(res.data || ''));
    const detalles = $('ul.post-details').first();
    return {
      original: detalles.find('[data-original-title]').first().attr('data-original-title')
        || detalles.attr('data-original-title'),
      year: detalles.find('[data-year]').first().attr('data-year') || detalles.attr('data-year'),
    };
  } catch {
    return null;
  }
}

(async () => {
  const filas: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('media_items')
      .select('id,title,original_title,release_date,tmdb_id,source_url,aliases')
      .like('source_url', '%fuegocine%')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    filas.push(...data);
    if (data.length < 1000) break;
  }

  // Solo las que adoptaron una ficha de TMDB: las que se quedaron con la metadata de su fuente
  // no pueden haber adoptado la de otra.
  const candidatas = filas.filter(f => f.tmdb_id && f.tmdb_id > 0);
  const paso = TODAS ? 1 : Math.max(1, Math.floor(candidatas.length / MUESTRA));
  const objetivo = TODAS
    ? candidatas
    : Array.from({ length: Math.min(MUESTRA, candidatas.length) }, (_, i) => candidatas[i * paso]).filter(Boolean);

  console.log(`${candidatas.length} fichas de FuegoCine con ficha de TMDB adoptada · comprobando ${objetivo.length}\n`);

  const malas: string[] = [];
  let sinDato = 0;
  let revisadas = 0;

  for (let i = 0; i < objetivo.length; i += 8) {
    await Promise.all(
      objetivo.slice(i, i + 8).map(async f => {
        const det = await detallesDeLaPagina(f.source_url);
        if (!det?.original) { sinDato++; return; }
        revisadas++;

        const nombres = [f.title, f.original_title, ...(f.aliases || [])].filter(Boolean);
        const parecido = Math.max(0, ...nombres.map((n: string) => similarity(det.original!, n)));
        if (parecido >= PARECIDO_MINIMO) return;

        malas.push(
          `   ${f.id}\n` +
          `      guardada como : "${f.title}" (${String(f.release_date).slice(0, 4)}, tmdb ${f.tmdb_id}) · original "${f.original_title}"\n` +
          `      la fuente dice: "${det.original}" (${det.year || '?'})   ← parecido ${parecido.toFixed(2)}\n` +
          `      ${f.source_url}`
        );
      })
    );
    if ((i + 8) % 80 === 0) console.log(`   ${Math.min(i + 8, objetivo.length)}/${objetivo.length}…`);
  }

  console.log(`\n📊 ${revisadas} fichas con título original publicado · ${sinDato} sin ese dato`);
  console.log(`❌ ${malas.length} contradicen a su fuente (${revisadas ? ((malas.length / revisadas) * 100).toFixed(1) : 0}%)\n`);
  for (const m of malas.slice(0, 40)) console.log(m + '\n');
})();
