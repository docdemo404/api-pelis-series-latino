import 'dotenv/config';
import { getSupabaseAdmin } from '../src/services/supabaseService';
import { pelicula, episodio, buscarNetflixId, masterHls } from '../src/scrapers/netmirror';
import { tieneEspanolLatino, traducirYNormalizar } from '../src/utils/idiomas';
import { TMDB_API_KEY, OTRO_ALFABETO } from '../src/services/tmdbService';
import { leerAjuste } from '../src/utils/ajustesRemotos';

/**
 * Escaneo del catálogo contra NetMirror.
 *
 * Recorre las fichas con tmdb_id y para cada una:
 *   1. Comprueba si NetMirror la tiene (via `/api/embed-tmdb/{tmdb}` mp4 mono-audio) → `disponible`.
 *   2. Resuelve su `netflix_id` (via `/search.php?s=<titulo>` sin token).
 *   3. Llama al HLS master NewTV (sin token) y guarda las pistas de audio disponibles
 *      normalizadas al español. Sólo publica metadata si es multipista e incluye Español Latino.
 *
 * Para pelis: (tmdb, 0, 0). Para series: (tmdbSerie, 0, 0) — a nivel serie con sonda S1E1.
 *
 *   npx tsx scripts/scanNetmirror.ts
 *   npx tsx scripts/scanNetmirror.ts --tipo=movie
 *   npx tsx scripts/scanNetmirror.ts --refrescar         # revisa lo ya cacheado
 *   npx tsx scripts/scanNetmirror.ts --solo-idiomas      # solo pobla netflix_id + audios
 *                                                       # (no revisa disponible: ya está)
 *   npx tsx scripts/scanNetmirror.ts --limite=500
 *   NM_TOKEN_ESCANEO="…" npx tsx scripts/scanNetmirror.ts   # respaldo legacy opcional
 */

const args = process.argv.slice(2);
const soloTipo = args.find(a => a.startsWith('--tipo='))?.split('=')[1] as 'movie' | 'tvseries' | undefined;
const refrescar = args.includes('--refrescar');
const soloIdiomas = args.includes('--solo-idiomas');
// Rematch: solo fichas con disponible=true y netflix_id NULL. Usa el matcher agresivo con
// titulo en ingles de TMDB. Rescata las 5.000 fichas que el matcher viejo dejaba fuera por
// tener original_title en coreano/chino/japones/ruso/arabe y title en espanol.
const soloSinId = args.includes('--solo-sin-id');
// Rematch mas amplio: toca las que tienen netflix_id pero NO idiomas (probablemente el id que
// tenian era bogus — se colo durante el bug del search sin Referer, ver netmirror.ts).
// Cubre tambien las que directamente no tenian netflix_id. En resumen: cualquier ficha con
// mp4 disponible y sin audios reales poblados. Ejemplo: El Camino (Breaking Bad) tenia
// netflix_id 81437051 en cache pero el correcto es 81078819; con este modo se sobrescribe.
const sinAudios = args.includes('--sin-audios');
/** Modos que completan metadata sobre una fila existente sin volver a decidir disponibilidad. */
const soloMetadata = soloIdiomas || soloSinId || sinAudios;
const LIMITE = Number(args.find(a => a.startsWith('--limite='))?.split('=')[1] || 0) || Infinity;
const CONCURRENCIA = Math.max(1, Math.min(12,
  Number(args.find(a => a.startsWith('--concurrencia='))?.split('=')[1] || 3) || 3,
));
const PAUSA_LOTE_MS = 100;
const REFRESCAR_TRAS_DIAS = 14;

// NewTV no necesita token. Se conserva el token de sesión únicamente como respaldo del master
// antiguo mientras termina de propagarse un título nuevo.
let NM_TOKEN = process.env.NM_TOKEN_ESCANEO || '';
async function cargarTokenSiFalta(): Promise<void> {
  if (NM_TOKEN) return;
  try {
    const ajuste = await leerAjuste<{ token: string; emitido_at?: string }>('nm-token');
    if (ajuste?.token) {
      const edadH = ajuste.emitido_at ? (Date.now() - Date.parse(ajuste.emitido_at)) / 3_600_000 : 0;
      NM_TOKEN = ajuste.token;
      console.log(`  token NM cargado del ajuste remoto (edad ${edadH.toFixed(1)} h)`);
    }
  } catch { /* sin token, se sigue sin poblar idiomas */ }
}

const sb = getSupabaseAdmin();
/** Evita volver a buscar por título los IDs que el barrido anterior ya resolvió. */
const netflixIdConocido = new Map<number, string>();

interface Ficha { id: string; tmdb_id: number; type: 'movie' | 'tvseries'; title: string; original_title?: string; release_date?: string }

// Cache en memoria del titulo en INGLES por (tipo, tmdb). Solo se pregunta a TMDB si
// original_title esta en otro alfabeto o esta vacio. TMDB da title/name en en-US inequivoco.
const cacheTituloEn = new Map<string, string | null>();
async function tituloIngles(tipo: 'movie' | 'tvseries', tmdbId: number, originalTitle?: string): Promise<string | null> {
  if (originalTitle && !OTRO_ALFABETO.test(originalTitle) && originalTitle.trim().length > 0) return null;
  const key = `${tipo}:${tmdbId}`;
  if (cacheTituloEn.has(key)) return cacheTituloEn.get(key)!;
  try {
    const ruta = tipo === 'movie' ? 'movie' : 'tv';
    const r = await fetch(`https://api.themoviedb.org/3/${ruta}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`);
    if (!r.ok) { cacheTituloEn.set(key, null); return null; }
    const j = await r.json() as { title?: string; name?: string };
    const t = (j.title || j.name || '').trim() || null;
    cacheTituloEn.set(key, t);
    return t;
  } catch { cacheTituloEn.set(key, null); return null; }
}

async function yaCacheado(tmdbId: number, temporada: number, episodio: number): Promise<boolean> {
  const { data } = await sb.from('netmirror_cache')
    .select('comprobado_at,netflix_id,idiomas_audio')
    .eq('tmdb_id', tmdbId).eq('temporada', temporada).eq('episodio', episodio)
    .maybeSingle();
  if (!data) return false;
  if (refrescar) return false;
  // En modo `--solo-idiomas` decidimos con criterios distintos: se salta si ya tiene
  // netflix_id + idiomas.
  if (soloIdiomas) return Boolean(
    (data as any).netflix_id
    && Array.isArray((data as any).idiomas_audio)
    && (data as any).idiomas_audio.length >= 2
    && tieneEspanolLatino((data as any).idiomas_audio),
  );
  // En modo `--solo-sin-id` se salta si YA tiene netflix_id (ya se rescato o nunca lo perdio).
  if (soloSinId) return Boolean((data as any).netflix_id);
  // En modo `--sin-audios` se salta si YA tiene idiomas poblados. Cualquier fila con idiomas
  // reales ya funciona; las que tengan netflix_id pero sin idiomas se reprocesan por si su id
  // fue bogus. Solo si hay token — sin token no se puede poblar audios y no vale la pena.
  if (sinAudios) return Boolean(
    Array.isArray((data as any).idiomas_audio)
    && (data as any).idiomas_audio.length >= 2
    && tieneEspanolLatino((data as any).idiomas_audio),
  );
  const dias = (Date.now() - Date.parse(data.comprobado_at)) / 86_400_000;
  return dias < REFRESCAR_TRAS_DIAS;
}

async function guardar(row: Record<string, unknown>) {
  const marca = { ...row, comprobado_at: new Date().toISOString() };
  // Los modos de rescate también cubren servidores NetMirror persistidos antes de que existiera
  // `netmirror_cache`. En esos casos UPDATE no toca ninguna fila y el netflix_id se pierde sin
  // error. El propio servidor persistido ya prueba disponibilidad, por eso el UPSERT puede crear
  // la fila con `disponible=true` sin volver a llamar a embed-tmdb.
  if (soloSinId || sinAudios) {
    await sb.from('netmirror_cache').upsert(
      { ...marca, disponible: true },
      { onConflict: 'tmdb_id,temporada,episodio' },
    );
    return;
  }
  // `--solo-idiomas` históricamente recorre fichas generales y no demuestra disponibilidad;
  // ahí se conserva UPDATE puro para no crear positivos falsos.
  if (soloIdiomas) {
    const { tmdb_id, temporada, episodio, ...set } = marca as any;
    await sb.from('netmirror_cache').update(set)
      .eq('tmdb_id', tmdb_id).eq('temporada', temporada).eq('episodio', episodio);
    return;
  }
  await sb.from('netmirror_cache').upsert(marca, { onConflict: 'tmdb_id,temporada,episodio' });
}

async function comprobarFicha(f: Ficha, s: number, e: number): Promise<{
  disponible: boolean;
  resolucion: number | null;
  netflix_id: string | null;
  idiomas_audio: Array<{ lang: string; name_es: string; default: boolean }> | null;
  dominio_hls: string | null;
}> {
  const salida = {
    disponible: false as boolean,
    resolucion: null as number | null,
    netflix_id: null as string | null,
    idiomas_audio: null as any,
    dominio_hls: null as string | null,
  };


  // Paso 1 — disponibilidad via embed-tmdb (mp4 mono-audio). Solo si estamos escaneando.
  if (!soloMetadata) {
    const r = f.type === 'movie'
      ? await pelicula(f.tmdb_id).catch(() => null)
      : await episodio(f.tmdb_id, 1, 1).catch(() => null);
    salida.disponible = Boolean(r);
    salida.resolucion = r ? Number(r.meta.resolution) || null : null;
  }

  // Paso 2 — netflix_id via /search.php. Barato, sin token. Se prueban en orden:
  //   1. Titulo en INGLES traido de TMDB si original_title esta en otro alfabeto o vacio.
  //      Rescata coreano ("오징어 게임" -> "Squid Game"), japones, chino, ruso, arabe.
  //   2. original_title si es alfabeto latino ("Star Wars: A New Hope").
  //   3. title (traducido al espanol) por si es peli hispanohablante.
  // Y el matcher aplica variantes agresivas (sin subtitulo, sin sufijo numerico, sin articulo).
  const anio = f.release_date ? f.release_date.slice(0, 4) : undefined;
  const enIngles = await tituloIngles(f.type, f.tmdb_id, f.original_title).catch(() => null);
  const idConocido = netflixIdConocido.get(f.tmdb_id) || null;
  salida.netflix_id = idConocido
    || await buscarNetflixId(f.title, anio, f.original_title, enIngles || undefined).catch(() => null);
  if (salida.netflix_id) netflixIdConocido.set(f.tmdb_id, salida.netflix_id);

  // Paso 3 — con netflix_id poblamos idiomas_audio desde NewTV (sin token).
  if (salida.netflix_id) {
    let m = await masterHls(salida.netflix_id, NM_TOKEN).catch(() => null);
    // Parte de los IDs históricos se guardó durante el bug de "Top Searches" y apunta a otra
    // obra. Si ese master no existe, se vuelve a emparejar por título y se prueba el ID fresco.
    if (!m && idConocido) {
      const corregido = await buscarNetflixId(f.title, anio, f.original_title, enIngles || undefined)
        .catch(() => null);
      if (corregido && corregido !== salida.netflix_id) {
        salida.netflix_id = corregido;
        netflixIdConocido.set(f.tmdb_id, corregido);
        m = await masterHls(corregido, NM_TOKEN).catch(() => null);
      }
    }
    if (m && m.audios.length >= 2) {
      const idiomas = traducirYNormalizar(
        m.audios.map(a => ({ language: a.language, name: a.name, uri: a.uri })),
        salida.netflix_id,
      );
      if (!tieneEspanolLatino(idiomas)) return salida;
      salida.idiomas_audio = idiomas;
      // Es el host del MASTER, no el CDN de una pista. El cliente reconstruye la ruta NewTV.
      try { salida.dominio_hls = new URL(m.masterUrl).hostname; } catch { /* dejar null */ }
    }
  }

  return salida;
}

async function pool<T>(items: T[], concurr: number, fn: (x: T) => Promise<void>) {
  const iter = items[Symbol.iterator]();
  const runners = Array.from({ length: concurr }, async () => {
    for (const it of iter as any) {
      await fn(it);
      if (PAUSA_LOTE_MS > 0) await new Promise(r => setTimeout(r, PAUSA_LOTE_MS));
    }
  });
  await Promise.all(runners);
}

async function main() {
  await cargarTokenSiFalta();
  console.log(`Escaneo NetMirror  concurr=${CONCURRENCIA}  refrescar=${refrescar}  soloIdiomas=${soloIdiomas}  soloSinId=${soloSinId}  sinAudios=${sinAudios}  tipo=${soloTipo || 'todos'}  token=${NM_TOKEN ? 'sí' : 'no'}`);

  const tipos: Array<'movie' | 'tvseries'> = soloTipo ? [soloTipo] : ['movie', 'tvseries'];
  const stats = { procesadas: 0, pelisOk: 0, pelisNo: 0, seriesOk: 0, seriesNo: 0, saltadas: 0, netflix: 0, conIdiomas: 0 };
  const t0 = Date.now();

  // Cuando `--solo-sin-id`, precargamos los tmdb_id que estan en netmirror_cache con
  // disponible=true y netflix_id NULL. Sin este filtro recorreriamos las 10k+ filas del
  // catalogo entero. Se pagina en trozos de 1000 respetando [[range-sin-order-miente]].
  const tmdbIdsRematch = new Set<number>();
  if (soloSinId) {
    let off = 0;
    for (;;) {
      const { data } = await sb.from('netmirror_cache')
        .select('tmdb_id,netflix_id')
        .eq('disponible', true).is('netflix_id', null)
        .order('tmdb_id').range(off, off + 999);
      const filas = data || [];
      for (const f of filas) {
        tmdbIdsRematch.add((f as any).tmdb_id);
        if ((f as any).netflix_id) netflixIdConocido.set((f as any).tmdb_id, String((f as any).netflix_id));
      }
      if (filas.length < 1000) break;
      off += 1000;
    }
    console.log(`  rematch sobre ${tmdbIdsRematch.size} fichas sin netflix_id`);
  } else if (sinAudios) {
    let off = 0;
    for (;;) {
      const { data } = await sb.from('netmirror_cache')
        .select('tmdb_id,netflix_id')
        .eq('disponible', true).is('idiomas_audio', null)
        .order('tmdb_id').range(off, off + 999);
      const filas = data || [];
      for (const f of filas) {
        tmdbIdsRematch.add((f as any).tmdb_id);
        if ((f as any).netflix_id) netflixIdConocido.set((f as any).tmdb_id, String((f as any).netflix_id));
      }
      if (filas.length < 1000) break;
      off += 1000;
    }

    // Hubo servidores NetMirror escritos directamente en `media_items.servers` antes de crear
    // `netmirror_cache`; esas fichas son justo las que hoy reproducen el MP4 inglés y nunca
    // reciben `netflix_id`. Se incorporan al rescate aunque todavía no tengan fila auxiliar.
    off = 0;
    for (;;) {
      const { data } = await sb.from('media_items')
        .select('tmdb_id,servers')
        .eq('type', 'movie').gt('tmdb_id', 0)
        .order('tmdb_id').range(off, off + 999);
      const filas = data || [];
      for (const f of filas as Array<{ tmdb_id: number; servers?: any[] }>) {
        const tieneNetmirror = (f.servers || []).some(sv =>
          String(sv?.source_id || '').toLowerCase() === 'netmirror'
          || /\/netmirror\/stream\//i.test(String(sv?.direct_stream || sv?.embed_url || '')),
        );
        if (tieneNetmirror) {
          tmdbIdsRematch.add(f.tmdb_id);
          const idPersistido = (f.servers || []).find(sv => sv?.netmirror_hls?.netflix_id)
            ?.netmirror_hls?.netflix_id;
          if (idPersistido) netflixIdConocido.set(f.tmdb_id, String(idPersistido));
        }
      }
      if (filas.length < 1000) break;
      off += 1000;
    }
    console.log(`  rematch sobre ${tmdbIdsRematch.size} fichas NetMirror sin audios/ID completo`);
  }

  for (const tipo of tipos) {
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.from('media_items')
        .select('id,tmdb_id,type,title,original_title,release_date')
        .eq('type', tipo).gt('tmdb_id', 0)
        .order('tmdb_id')
        .range(offset, offset + 999);
      if (error) { console.error(error); break; }
      const filas = (data as Ficha[]) || [];
      if (filas.length === 0) break;

      await pool(filas, CONCURRENCIA, async f => {
        if (stats.procesadas >= LIMITE) return;
        // En modos de rescate filtramos las que no estan en la lista precalculada. Esto reduce
        // el trabajo real de 10k a los ~5k que faltan.
        if ((soloSinId || sinAudios) && !tmdbIdsRematch.has(f.tmdb_id)) { stats.saltadas++; return; }
        const s = tipo === 'movie' ? 0 : 1;
        const e = tipo === 'movie' ? 0 : 1;
        if (await yaCacheado(f.tmdb_id, s, e)) { stats.saltadas++; return; }
        const r = await comprobarFicha(f, s, e);

        // En `--solo-idiomas` solo actualizamos columnas nuevas (no `disponible`, que ya está).
        const row: Record<string, unknown> = { tmdb_id: f.tmdb_id, temporada: s, episodio: e };
        // En rescate, un timeout del buscador no puede borrar un ID que ya estaba guardado.
        // Solo se escriben mejoras reales; en el escaneo completo sí se registra también null.
        if (!soloMetadata || r.netflix_id) row.netflix_id = r.netflix_id;
        if (!soloMetadata || r.idiomas_audio) row.idiomas_audio = r.idiomas_audio;
        if (!soloMetadata || r.dominio_hls) row.dominio_hls = r.dominio_hls;
        if (!soloMetadata) {
          row.disponible = r.disponible;
          row.resolucion = r.resolucion;
        }
        await guardar(row);

        if (!soloMetadata) {
          if (r.disponible) { if (tipo === 'movie') stats.pelisOk++; else stats.seriesOk++; }
          else { if (tipo === 'movie') stats.pelisNo++; else stats.seriesNo++; }
        }
        if (r.netflix_id) stats.netflix++;
        if (r.idiomas_audio) stats.conIdiomas++;
        stats.procesadas++;
        if (stats.procesadas % 100 === 0) {
          const dt = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`  ${stats.procesadas}  ${dt}s  disp=${stats.pelisOk + stats.seriesOk}/${stats.pelisOk + stats.pelisNo + stats.seriesOk + stats.seriesNo}  netflix_id=${stats.netflix}  idiomas=${stats.conIdiomas}`);
        }
      });

      if (stats.procesadas >= LIMITE) break;
      offset += 1000;
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('---');
  console.log(`Pelis:  ${stats.pelisOk} disp  ${stats.pelisNo} no  |  Series: ${stats.seriesOk} disp  ${stats.seriesNo} no`);
  console.log(`Netflix ids resueltos: ${stats.netflix}   Idiomas poblados: ${stats.conIdiomas}   Saltadas: ${stats.saltadas}`);
  console.log(`Total: ${dt}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
