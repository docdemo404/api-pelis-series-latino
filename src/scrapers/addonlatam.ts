/**
 * ADDON LATAM — fuente de RESPALDO (prioridad baja). Es un addon de Stremio que reempaqueta paneles
 * IPTV Xtream (tvprem.pro, xuperiptv, IPs sueltas) con credenciales compartidas metidas en la URL.
 *
 * Por qué respaldo y no fuente principal: esas credenciales ROTAN/CADUCAN a menudo (los paneles
 * banean el uso compartido), hay límite de conexiones por cuenta, van por HTTP en claro, y varias
 * "opciones" son IP privadas (10.x / .in-addr.arpa) inalcanzables desde fuera. Se filtran aquí.
 *
 * Va por id de IMDB (Stremio). El token de la ruta puede rotar como en otros addons; por eso la base
 * es configurable por entorno (`ADDONLATAM_BASE`).
 */
import { httpClient } from '../utils/httpClient';

export const BASE_ADDONLATAM =
  process.env.ADDONLATAM_BASE || 'https://addonlatam.duckdns.org/Vk_NWD0WV4vUoAjAx_Kz3Dkp';

export interface StreamAddonLatam {
  url: string;
  titulo: string;
  idioma: 'latino' | 'ingles' | 'otro';
  calidad: string; // '4k' | '1080' | '720' | '' …
}

/** Hosts inalcanzables desde fuera (privados/loopback/reverse-dns de privadas): se descartan. */
export function esHostInalcanzable(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^127\./.test(h) ||
      h === 'localhost' ||
      h.endsWith('.in-addr.arpa')
    );
  } catch {
    return true;
  }
}

function idiomaDe(titulo: string): StreamAddonLatam['idioma'] {
  const t = titulo.toLowerCase();
  if (t.includes('latino')) return 'latino';
  if (t.includes('inglés') || t.includes('ingles') || t.includes('english')) return 'ingles';
  return 'otro';
}

function calidadDe(titulo: string): string {
  const t = titulo.toLowerCase();
  if (t.includes('4k') || t.includes('2160')) return '4k';
  if (t.includes('1080')) return '1080';
  if (t.includes('720')) return '720';
  return '';
}

/** Id de Stremio: película = ttID; serie = ttID:temporada:capitulo. */
export function idDeStremio(imdbId: string, temporada?: number, capitulo?: number): string {
  return temporada && capitulo ? `${imdbId}:${temporada}:${capitulo}` : imdbId;
}

/**
 * Resuelve los streams de un título por su IMDB id. Devuelve solo los ALCANZABLES, con el Latino
 * primero. La llamada real al panel (302 al VOD) ocurre al reproducir; aquí solo se listan candidatos.
 */
export async function resolverAddonLatam(
  imdbId: string,
  tipo: 'movie' | 'series',
  temporada?: number,
  capitulo?: number,
): Promise<StreamAddonLatam[]> {
  if (!/^tt\d+$/.test(imdbId)) return [];
  const id = idDeStremio(imdbId, temporada, capitulo);
  const url = `${BASE_ADDONLATAM}/stream/${tipo}/${encodeURIComponent(id)}.json`;
  try {
    const r = await httpClient.get(url, { timeout: 15000, validateStatus: () => true });
    if (r.status !== 200) return [];
    const streams: any[] = Array.isArray(r.data?.streams) ? r.data.streams : [];
    const limpios: StreamAddonLatam[] = [];
    for (const s of streams) {
      const u = String(s?.url || '');
      if (!u || !/^https?:\/\//i.test(u)) continue; // ignora entradas sin url (reportar/solicitar)
      if (esHostInalcanzable(u)) continue;          // tira IP privadas / reverse-dns de privadas
      const titulo = String(s?.title || '').replace(/\s+/g, ' ').trim();
      limpios.push({ url: u, titulo, idioma: idiomaDe(titulo), calidad: calidadDe(titulo) });
    }
    // Latino primero; dentro, 4k/1080 antes.
    const peso = (s: StreamAddonLatam) =>
      (s.idioma === 'latino' ? 0 : s.idioma === 'otro' ? 1 : 2) * 10 +
      (s.calidad === '4k' ? 0 : s.calidad === '1080' ? 1 : s.calidad === '720' ? 2 : 3);
    return limpios.sort((a, b) => peso(a) - peso(b));
  } catch {
    return [];
  }
}

export function esUrlDeAddonLatam(url: string): boolean {
  try {
    return new URL(url).hostname.includes('addonlatam');
  } catch {
    return false;
  }
}
