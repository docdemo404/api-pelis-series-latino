/**
 * LO QUE EL MÓVIL NOS CUENTA DE PLUTO TV. Ver src/scrapers/pluto.ts para el reparto entero.
 *
 * Aquí solo se GUARDA: ni se identifica ni se publica. Identificar son cuatro preguntas a TMDB
 * por título y no caben en una función de Vercel con 250 títulos por lote; eso lo hace el
 * importador en GitHub.
 *
 * SIN QUORUM, A DIFERENCIA DE NETMIRROR. Allí se exige que dos redes distintas coincidan, y con
 * los aparatos que hay hoy la cola lleva 56.849 tareas pendientes y 0 confirmadas: la regla es
 * correcta y no publica nada. Aquí basta un aparato porque lo que manda no decide la identidad
 * —eso lo hace el importador contra TMDB con año y director— y lo único que acaba en una url es
 * el id de Pluto, que se valida por forma. Lo peor que puede colar un informe falso es un
 * servidor que no abre, y el failover del reproductor lo salta.
 */
import { asegurarEsquema, getDb } from '../db/libsql';
import { ID_PLUTO, norm } from '../scrapers/pluto';
import { DEFAULT_SOURCES } from '../config/sources';

/**
 * Con la fuente apagada los informes se aceptan (200, para que el móvil no reintente) pero no se
 * guardan: cada informe son ~1.800 filas escritas, y las escrituras de Turso son lo que se agota.
 */
const plutoActivo = () => DEFAULT_SOURCES.find((s) => s.id === 'pluto')?.enabled !== false;

const MAX_LOTE = 400;

export class InformePlutoInvalido extends Error {}

function dispositivoValido(id: unknown): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{16,128}$/.test(id);
}

const texto = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const entero = (v: unknown, min: number, max: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/**
 * Un lote del catálogo que ve el aparato. Devuelve, de ese mismo lote, los ids a los que el móvil
 * debe mirarles el audio: los ya identificados que nadie ha mirado todavía.
 */
export async function recibirCatalogoPluto(cuerpo: any): Promise<{ guardados: number; audios_pendientes: string[] }> {
  if (!dispositivoValido(cuerpo?.device_id)) throw new InformePlutoInvalido('device_id');
  const items = Array.isArray(cuerpo?.items) ? cuerpo.items.slice(0, MAX_LOTE) : [];
  const pais = /^[A-Z]{2}$/.test(String(cuerpo?.pais || '')) ? String(cuerpo.pais) : null;
  const ahora = new Date().toISOString();

  const filas = items
    .filter((i: any) => ID_PLUTO.test(String(i?.id || '')) && texto(i?.nombre, 200))
    .map((i: any) => ({
      id: String(i.id),
      nombre: texto(i.nombre, 200),
      anio: entero(i.anio, 1900, 2100),
      minutos: entero(i.minutos, 1, 600),
      directores: JSON.stringify(
        (Array.isArray(i.directores) ? i.directores : []).slice(0, 8).map((d: unknown) => norm(texto(d, 80))).filter(Boolean),
      ),
    }));
  if (!filas.length || !plutoActivo()) return { guardados: 0, audios_pendientes: [] };

  await asegurarEsquema();
  const db = getDb();
  // Si cambian los datos de identidad, el veredicto anterior ya no vale: se vuelve a identificar.
  await db.batch(filas.map((f: any) => ({
    sql: `INSERT INTO pluto_titulos (pluto_id,nombre,anio,minutos,directores,pais,visto_at)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(pluto_id) DO UPDATE SET
            visto_at=excluded.visto_at, pais=excluded.pais,
            veredicto=CASE WHEN pluto_titulos.nombre IS NOT excluded.nombre OR pluto_titulos.anio IS NOT excluded.anio
                             OR pluto_titulos.minutos IS NOT excluded.minutos OR pluto_titulos.directores IS NOT excluded.directores
                           THEN NULL ELSE pluto_titulos.veredicto END,
            nombre=excluded.nombre, anio=excluded.anio, minutos=excluded.minutos, directores=excluded.directores`,
    args: [f.id, f.nombre, f.anio, f.minutos, f.directores, pais, ahora],
  })), 'write');

  const marcas = filas.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `SELECT pluto_id FROM pluto_titulos
          WHERE pluto_id IN (${marcas}) AND veredicto='verificada' AND audios_at IS NULL`,
    args: filas.map((f: any) => f.id),
  });
  return { guardados: filas.length, audios_pendientes: rs.rows.map((r: any) => String(r.pluto_id ?? r[0])) };
}

/** Los idiomas de audio que el móvil leyó en el master (`LANGUAGE="es"`), por id. */
export async function recibirAudiosPluto(cuerpo: any): Promise<{ guardados: number }> {
  if (!dispositivoValido(cuerpo?.device_id)) throw new InformePlutoInvalido('device_id');
  const items = (Array.isArray(cuerpo?.items) ? cuerpo.items.slice(0, MAX_LOTE) : [])
    .filter((i: any) => ID_PLUTO.test(String(i?.id || '')) && Array.isArray(i?.audios))
    .map((i: any) => ({
      id: String(i.id),
      audios: JSON.stringify(
        [...new Set<string>(i.audios.slice(0, 12).map((a: unknown) => texto(a, 12).toLowerCase()).filter(Boolean))],
      ),
    }));
  if (!items.length || !plutoActivo()) return { guardados: 0 };
  await asegurarEsquema();
  const ahora = new Date().toISOString();
  await getDb().batch(items.map((i: any) => ({
    sql: 'UPDATE pluto_titulos SET audios=?, audios_at=? WHERE pluto_id=?',
    args: [i.audios, ahora, i.id],
  })), 'write');
  return { guardados: items.length };
}

export async function estadoPluto(): Promise<Record<string, unknown>> {
  await asegurarEsquema();
  const rs = await getDb().execute(`
    SELECT count(*) AS total,
           sum(veredicto IS NULL) AS sin_identificar,
           sum(veredicto='verificada') AS verificadas,
           sum(veredicto='verificada' AND audios_at IS NULL) AS sin_audio,
           sum(publicado_at IS NOT NULL) AS publicadas,
           max(visto_at) AS ultimo_informe
    FROM pluto_titulos`);
  const r: any = rs.rows[0] || {};
  return {
    total: Number(r.total || 0), sin_identificar: Number(r.sin_identificar || 0),
    verificadas: Number(r.verificadas || 0), sin_audio: Number(r.sin_audio || 0),
    publicadas: Number(r.publicadas || 0), ultimo_informe: r.ultimo_informe || null,
  };
}
