/**
 * Prepara candidatos de Netflix, Prime Video y Hotstar/Disney+ sin tocar NetMirror.
 * GitHub/TMDB enumera; instalaciones Android voluntarias comprueban lotes pequenos.
 */
import 'dotenv/config';
import { asegurarEsquema, getDb } from '../src/db/libsql';
import { TMDB_API_KEY } from '../src/services/tmdbService';
import { NetmirrorOtt } from '../src/scrapers/netmirror';

const argv = process.argv.slice(2);
const texto = (nombre: string, defecto: string) =>
  (argv.find(a => a.startsWith(`--${nombre}=`)) || '').split('=').slice(1).join('=') || defecto;
const numero = (nombre: string, defecto: number) => {
  const n = Number(texto(nombre, String(defecto)));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : defecto;
};
const PAGINAS = Math.min(500, numero('paginas', 500));
const REGIONES = texto('regiones', 'IN,MX,AR,CL,CO,PE,BR,ES,US,CA,GB,AU,DE,FR,IT')
  .split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
const PROVEEDOR = texto('proveedor', 'todos').toLowerCase();

const PLATAFORMAS: Record<string, { ott: NetmirrorOtt; ids: (region: string) => number[] }> = {
  nf: { ott: 'nf', ids: () => [8] }, netflix: { ott: 'nf', ids: () => [8] },
  pv: { ott: 'pv', ids: r => r === 'US' ? [9, 119] : [119, 9] },
  prime: { ott: 'pv', ids: r => r === 'US' ? [9, 119] : [119, 9] },
  hs: { ott: 'hs', ids: () => [122, 337] }, hotstar: { ott: 'hs', ids: () => [122, 337] },
  disney: { ott: 'hs', ids: () => [337, 122] },
};
interface Candidata { tmdbId: number; ott: NetmirrorOtt; titulo: string; original: string; anio: string; prioridad: number }

async function pagina(provider: number, region: string, page: number): Promise<any | null> {
  const q = new URLSearchParams({
    api_key: TMDB_API_KEY, language: 'en-US', with_watch_providers: String(provider),
    watch_region: region, sort_by: 'popularity.desc', page: String(page),
  });
  for (let intento = 0; intento < 4; intento++) {
    try {
      const r = await fetch(`https://api.themoviedb.org/3/discover/movie?${q}`, { signal: AbortSignal.timeout(20_000) });
      if (r.status === 429) { await new Promise(ok => setTimeout(ok, 1500 * (intento + 1))); continue; }
      return r.ok ? r.json() : null;
    } catch { /* reintento */ }
  }
  return null;
}

async function main(): Promise<void> {
  if (!TMDB_API_KEY) throw new Error('Falta TMDB_API_KEY');
  await asegurarEsquema();
  const elegidas = PROVEEDOR === 'todos' || PROVEEDOR === 'all'
    ? [PLATAFORMAS.nf, PLATAFORMAS.pv, PLATAFORMAS.hs]
    : [PLATAFORMAS[PROVEEDOR]].filter(Boolean);
  if (!elegidas.length) throw new Error(`Proveedor desconocido: ${PROVEEDOR}`);

  const candidatas = new Map<string, Candidata>();
  for (const plataforma of elegidas) for (const region of REGIONES) for (const provider of plataforma.ids(region)) {
    const primera = await pagina(provider, region, 1);
    if (!primera) continue;
    const total = Math.min(PAGINAS, Number(primera.total_pages || 1), 500);
    const anotar = (j: any, p: number) => {
      for (const m of j?.results || []) {
        const id = Number(m?.id);
        if (!id || !m?.title) continue;
        const clave = `${plataforma.ott}:${id}`;
        const previa = candidatas.get(clave);
        const prioridad = Math.max(0, 100_000 - p * 100 + Math.round(Number(m.popularity || 0)));
        if (!previa || prioridad > previa.prioridad) candidatas.set(clave, {
          tmdbId: id, ott: plataforma.ott, titulo: String(m.title),
          original: String(m.original_title || m.title), anio: String(m.release_date || '').slice(0, 4), prioridad,
        });
      }
    };
    anotar(primera, 1);
    for (let p = 2; p <= total; p += 4) {
      const lote: Promise<any | null>[] = [];
      for (let k = p; k < p + 4 && k <= total; k++) lote.push(pagina(provider, region, k));
      (await Promise.all(lote)).forEach((j, i) => anotar(j, p + i));
    }
    console.log(`${plataforma.ott}/${region}/${provider}: ${total} paginas -> ${candidatas.size} acumulados`);
  }

  const db = getDb();
  const lista = [...candidatas.values()];
  for (let i = 0; i < lista.length; i += 100) {
    const lote = lista.slice(i, i + 100).map(c => ({
      sql: `INSERT INTO netmirror_trabajos (tmdb_id,ott,titulo,titulo_original,anio,prioridad)
            VALUES (?,?,?,?,?,?) ON CONFLICT(tmdb_id,ott) DO UPDATE SET
            titulo=excluded.titulo,titulo_original=excluded.titulo_original,anio=excluded.anio,
            prioridad=max(netmirror_trabajos.prioridad,excluded.prioridad),
            actualizado_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      args: [c.tmdbId, c.ott, c.titulo, c.original, c.anio, c.prioridad],
    }));
    await db.batch(lote, 'write');
    if ((i + lote.length) % 1000 === 0) console.log(`${i + lote.length}/${lista.length} candidatos guardados`);
  }
  console.log(`Cola preparada: ${lista.length} pares titulo/plataforma.`);
}

main().catch(e => { console.error(e); process.exit(1); });
