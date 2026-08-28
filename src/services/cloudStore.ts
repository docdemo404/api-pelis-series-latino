import axios from 'axios';
import { SourceConfig, DEFAULT_SOURCES } from '../config/sources';
import { MediaOverride } from './overrideService';

// ─── Credenciales desde variables de entorno (nunca hardcodeadas) ────────────
const VERCEL_TOKEN = () => process.env.VERCEL_API_TOKEN || '';
const VERCEL_PROJECT_ID = () => process.env.VERCEL_PROJECT_ID || '';
const VERCEL_TEAM_ID = () => process.env.VERCEL_TEAM_ID || '';
const VERCEL_API = 'https://api.vercel.com';

// Cache en memoria (válido durante el proceso serverless)
let cachedSources: SourceConfig[] | null = null;
let cachedOverrides: Record<string, MediaOverride> | null = null;

// ─── Helpers Vercel Env API ─────────────────────────────────────────────────

async function getVercelEnv(key: string): Promise<string | null> {
  const token = VERCEL_TOKEN();
  const projectId = VERCEL_PROJECT_ID();
  const teamId = VERCEL_TEAM_ID();
  if (!token || !projectId) return null;

  try {
    const teamParam = teamId ? `&teamId=${teamId}` : '';
    const { data } = await axios.get(
      `${VERCEL_API}/v9/projects/${projectId}/env?${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    const envVar = data.envs?.find((e: any) => e.key === key);
    if (!envVar) return null;

    // Las env vars encriptadas requieren GET separado al ID del valor
    const valRes = await axios.get(
      `${VERCEL_API}/v9/projects/${projectId}/env/${envVar.id}?${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    return valRes.data?.value ?? null;
  } catch {
    return null;
  }
}

async function setVercelEnv(key: string, value: string): Promise<void> {
  const token = VERCEL_TOKEN();
  const projectId = VERCEL_PROJECT_ID();
  const teamId = VERCEL_TEAM_ID();
  if (!token || !projectId) return;

  const teamParam = teamId ? `?teamId=${teamId}` : '';
  const teamParamAmp = teamId ? `&teamId=${teamId}` : '';

  try {
    const { data } = await axios.get(
      `${VERCEL_API}/v9/projects/${projectId}/env${teamParam}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
    const existing = data.envs?.find((e: any) => e.key === key);

    if (existing) {
      await axios.patch(
        `${VERCEL_API}/v9/projects/${projectId}/env/${existing.id}${teamParam}`,
        { value, target: ['production', 'preview', 'development'], type: 'encrypted' },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
    } else {
      await axios.post(
        `${VERCEL_API}/v10/projects/${projectId}/env${teamParamAmp ? '?' + teamParamAmp.slice(1) : ''}`,
        [{ key, value, target: ['production', 'preview', 'development'], type: 'encrypted' }],
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
    }
  } catch (err: any) {
    console.warn('[CloudStore] Vercel env save error:', err?.response?.data || err.message);
  }
}

// ─── CloudStore principal ────────────────────────────────────────────────────

/**
 * EL VALOR VIVO DE UN AJUSTE — la API PRIMERO, el entorno del proceso como red de seguridad.
 *
 * El orden estaba al revés (`process.env` primero) y eso hacía que **el panel no pudiera cambiar
 * nada de verdad**, que es justamente para lo que existe. Vercel inyecta las variables en el
 * proceso al desplegar y ahí se quedan congeladas: quien guardaba desde el panel escribía bien en
 * la API, veía el cambio aplicado en su respuesta —porque la instancia que le atendió también
 * actualiza su caché— y a la petición siguiente le contestaba otra instancia con el valor viejo
 * horneado. El cambio parecía revertirse solo.
 *
 * Se descubrió el 2026-08-27 intentando poner `videoapi` en su prioridad: el POST contestaba con el
 * orden nuevo y las tres lecturas siguientes devolvían el viejo. La configuración guardada tenía
 * 37 días y aún nombraba a Cinecalidad.
 *
 * EL COSTE, que es real y por eso se acota: una llamada a la API de Vercel por instancia fría. Se
 * paga UNA vez —lo que salga se queda en la caché en memoria del proceso— y solo en los caminos
 * que de verdad piden esto (el panel y la búsqueda). Si la API no contesta, se cae al valor del
 * proceso, que es lo que había antes: nunca se queda sin respuesta por esto.
 */
async function leerAjusteVivo(clave: string): Promise<string | null> {
  try {
    const deLaApi = await getVercelEnv(clave);
    if (deLaApi) return deLaApi;
  } catch {}
  return process.env[clave] || null;
}

export class CloudStore {
  /**
   * Carga fuentes — prioridad: memoria → Vercel API → env del proceso.
   *
   * Ver `leerAjusteVivo` para por qué la API va antes que el entorno.
   */
  static async getSources(): Promise<SourceConfig[]> {
    if (cachedSources) return [...cachedSources];

    const raw = await leerAjusteVivo('APP_SOURCES_CONFIG');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          cachedSources = parsed.sort((a: SourceConfig, b: SourceConfig) => a.priority - b.priority);
          return [...cachedSources];
        }
      } catch {}
    }

    cachedSources = [...DEFAULT_SOURCES];
    return [...cachedSources];
  }

  /**
   * Un ajuste suelto del panel, leído de donde ya se leen las fuentes.
   *
   * `getSources` y `getOverrides` hacían cada uno su propia cadena, idéntica salvo por la clave.
   * Ahora los tres llaman a `leerAjusteVivo`, para que el ajuste siguiente no traiga una cuarta
   * copia — y para que invertir el orden, como hubo que hacer, se hiciera en UN sitio.
   */
  static async getAjuste(clave: string): Promise<string | null> {
    return leerAjusteVivo(clave);
  }

  /** Guarda ese ajuste. Persiste entre despliegues, como el resto de la configuración. */
  static async guardarAjuste(clave: string, valor: string): Promise<void> {
    // También en el proceso: si no, quien lo acaba de guardar seguiría leyendo lo viejo hasta que
    // la API de Vercel propague, y el panel parecería no haber hecho nada.
    process.env[clave] = valor;
    await setVercelEnv(clave, valor);
  }


  /**
   * Guarda fuentes en Vercel env var (persistente entre deploys)
   */
  static async saveSources(sources: SourceConfig[]): Promise<void> {
    const sorted = [...sources].sort((a, b) => a.priority - b.priority);
    cachedSources = sorted;
    // También en el proceso, igual que `guardarAjuste`: si la API tarda en propagar, esta misma
    // instancia debe seguir leyendo lo que acaba de guardar y no el valor del despliegue.
    const json = JSON.stringify(sorted);
    process.env.APP_SOURCES_CONFIG = json;
    await setVercelEnv('APP_SOURCES_CONFIG', json);
  }

  /**
   * Carga overrides — prioridad: memoria → Vercel API → env del proceso.
   *
   * Mismo orden y misma razón que `getSources`: un override puesto desde el panel tiene que valer
   * desde la siguiente petición, no desde el siguiente despliegue. Ver `leerAjusteVivo`.
   */
  static async getOverrides(): Promise<Record<string, MediaOverride>> {
    if (cachedOverrides) return { ...cachedOverrides };

    const raw = await leerAjusteVivo('APP_OVERRIDES_CONFIG');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          cachedOverrides = parsed as Record<string, MediaOverride>;
          return { ...cachedOverrides };
        }
      } catch {}
    }

    cachedOverrides = {};
    return {};
  }

  /**
   * Guarda un override de portada
   */
  static async saveOverride(key: string | number, override: MediaOverride): Promise<void> {
    const k = String(key).toLowerCase().trim();
    const current = await this.getOverrides();
    current[k] = {
      ...current[k],
      ...override,
      updated_at: new Date().toISOString()
    };
    cachedOverrides = current;
    await setVercelEnv('APP_OVERRIDES_CONFIG', JSON.stringify(current));
  }

  /**
   * Elimina un override de portada
   */
  static async deleteOverride(key: string | number): Promise<boolean> {
    const k = String(key).toLowerCase().trim();
    const current = await this.getOverrides();
    if (current[k]) {
      delete current[k];
      cachedOverrides = current;
      await setVercelEnv('APP_OVERRIDES_CONFIG', JSON.stringify(current));
      return true;
    }
    return false;
  }
}
