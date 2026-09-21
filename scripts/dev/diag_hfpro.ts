/**
 * ¿CUÁNTO APORTA HFPRO DE VERDAD? (2026-09-20)
 *
 * Esto se escribe ANTES del importador, y esta vez no por costumbre: con lamoviebot proyecté «~656
 * fichas nuevas» comparando `tmdb_id` contra el catálogo, y el número contaba SOLAPE en vez de
 * contenido reproducible. La realidad fue menos de la mitad, porque la mayoría de su cola no tenía
 * vídeo detrás. Un aporte se mide por lo que se puede ESCRIBIR, no por lo que se puede listar.
 *
 * Así que aquí se pregunta lo que de verdad decide, en este orden:
 *
 *   1. ¿Cuánto hay, una vez quitada la basura?
 *   2. ¿Cuánto sabe IDENTIFICAR nuestro matcher? (es la fuente de identidad más pobre que hay:
 *      solo el nombre del fichero, clase archive.org, así que se exige `verified`)
 *   3. De lo identificado, ¿cuánto NO tenemos ya?
 *   4. ¿Reproduce?
 *
 *   npx ts-node --transpile-only scripts/dev/diag_hfpro.ts
 *   npx ts-node --transpile-only scripts/dev/diag_hfpro.ts --series=80 --reproducir=6
 */
import 'dotenv/config';
import { supabase } from '../../src/services/supabaseService';
import { httpClient } from '../../src/utils/httpClient';
import { TmdbService } from '../../src/services/tmdbService';
import { listarPeliculas, listarSeries, UA_NAVEGADOR, SerieHfpro } from '../../src/scrapers/hfpro';

const N_SERIES = Number(process.argv.find((a) => a.startsWith('--series='))?.split('=')[1] || 60);
const N_REPRO = Number(process.argv.find((a) => a.startsWith('--reproducir='))?.split('=')[1] || 5);

/** Los tmdb_id que ya tenemos, paginando CON `.order()` (sin él, `.range()` se salta filas). */
async function nuestrosIds(tipo: 'movie' | 'tvseries'): Promise<Set<number>> {
  const out = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from('media_items').select('tmdb_id').eq('type', tipo).gt('tmdb_id', 0)
      .order('tmdb_id').range(desde, desde + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((r: any) => out.add(Number(r.tmdb_id)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Reparte la muestra por categorías, que no es lo mismo que tomar las primeras. */
function muestraRepartida(series: SerieHfpro[], cuantas: number): SerieHfpro[] {
  const porCat = new Map<string, SerieHfpro[]>();
  for (const s of series) porCat.set(s.categoria, [...(porCat.get(s.categoria) || []), s]);
  const cats = [...porCat.keys()];
  const out: SerieHfpro[] = [];
  for (let i = 0; out.length < cuantas; i++) {
    let metidas = 0;
    for (const c of cats) {
      const lista = porCat.get(c)!;
      if (i < lista.length && out.length < cuantas) { out.push(lista[i]); metidas++; }
    }
    if (!metidas) break;
  }
  return out;
}

async function main() {
  console.log('Bajando sus dos listas…');
  const [pelis, series] = await Promise.all([listarPeliculas(), listarSeries()]);
  const episodios = series.reduce((a, s) => a + s.episodios.length, 0);

  console.log(`\n── INVENTARIO (ya sin basura ni series mal archivadas) ──`);
  console.log(`  películas:  ${pelis.length}`);
  console.log(`  series:     ${series.length}`);
  console.log(`  episodios:  ${episodios}`);
  console.log(`  con año en el nombre:  series ${series.filter((s) => s.anio).length} · películas ${pelis.filter((p) => p.anio).length}`);
  const cats = new Map<string, number>();
  for (const s of series) cats.set(s.categoria, (cats.get(s.categoria) || 0) + 1);
  console.log(`  por categoría: ${[...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c}=${n}`).join(' · ')}`);

  console.log(`\n── ¿SABEMOS IDENTIFICARLAS? (muestra de ${N_SERIES} series repartidas) ──`);
  const yaTenemos = await nuestrosIds('tvseries');
  const muestra = muestraRepartida(series, N_SERIES);

  let verificadas = 0, soloParecido = 0, nada = 0, nuevas = 0, episodiosNuevos = 0;
  const fallos: string[] = [];
  const buenas: string[] = [];

  for (const s of muestra) {
    const m = await TmdbService.resolveTmdb(s.titulo, 'tvseries', s.anio ? String(s.anio) : undefined);
    if (m?.verified && m.id > 0) {
      verificadas++;
      if (!yaTenemos.has(m.id)) {
        nuevas++;
        episodiosNuevos += s.episodios.length;
        if (buenas.length < 8) buenas.push(`     + tmdb ${m.id}  "${s.titulo}"${s.anio ? ` (${s.anio})` : ''}  ${s.episodios.length} cap.`);
      }
    } else if (m?.matched) {
      soloParecido++;
      if (fallos.length < 8) fallos.push(`     ~ "${s.titulo}"${s.anio ? ` (${s.anio})` : ''} → solo parecido (score ${m.score?.toFixed?.(2)}), NO se adopta`);
    } else {
      nada++;
      if (fallos.length < 8) fallos.push(`     ✗ "${s.titulo}"${s.anio ? ` (${s.anio})` : ''} → sin candidato`);
    }
  }

  const pct = (n: number) => `${Math.round((n / Math.max(1, muestra.length)) * 100)} %`;
  console.log(`  respaldadas (verified): ${verificadas}  (${pct(verificadas)})`);
  console.log(`  solo parecido:          ${soloParecido}  ← NO se escriben (FUENTES.md §3)`);
  console.log(`  sin candidato:          ${nada}`);
  console.log(`  …de las respaldadas, NUEVAS para nosotros: ${nuevas}`);
  console.log(`  episodios que traerían esas nuevas:        ${episodiosNuevos}`);
  if (verificadas) {
    const porSerie = episodiosNuevos / Math.max(1, nuevas);
    console.log(`\n  PROYECCIÓN sobre sus ${series.length} series:`);
    console.log(`     ~${Math.round((verificadas / muestra.length) * series.length)} identificables`);
    console.log(`     ~${Math.round((nuevas / muestra.length) * series.length)} nuevas  ·  ~${Math.round((nuevas / muestra.length) * series.length * porSerie)} episodios`);
  }
  if (buenas.length) console.log(`\n  muestra de lo que entraría:\n${buenas.join('\n')}`);
  if (fallos.length) console.log(`\n  muestra de lo que NO:\n${fallos.join('\n')}`);

  console.log(`\n── ¿REPRODUCE? (${N_REPRO} ficheros, un rango real de 1 MB) ──`);
  const aProbar = muestra.slice(0, N_REPRO).map((s) => s.episodios[0]).filter(Boolean);
  let ok = 0;
  for (const e of aProbar) {
    try {
      const r = await httpClient.get(e.url, {
        timeout: 60000, responseType: 'arraybuffer', maxRedirects: 5,
        headers: { 'User-Agent': UA_NAVEGADOR, Range: 'bytes=0-1048575' },
        validateStatus: () => true,
      });
      const bytes = (r.data as ArrayBuffer)?.byteLength || 0;
      const bien = (r.status === 206 || r.status === 200) && bytes > 100_000;
      if (bien) ok++;
      console.log(`  ${bien ? '✓' : '✗'} http ${r.status} · ${Math.round(bytes / 1024)} KB · ${e.ruta.split('/').pop()}`);
    } catch (err: any) {
      console.log(`  ✗ ${String(err?.code || err?.message).slice(0, 30)} · ${e.ruta.split('/').pop()}`);
    }
  }
  console.log(`\n  reproducen: ${ok} de ${aProbar.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
