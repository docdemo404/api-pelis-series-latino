/**
 * Traducción de códigos ISO 639 al nombre en español + regla especial de `spa` (Latino/Castellano).
 *
 * NetMirror devuelve nombres en inglés ("Spanish", "French", "English") y el reproductor mostraba
 * eso literalmente. Regla del usuario: SIEMPRE en español, y cuando hay varias pistas `spa`, la
 * primera suele ser Latino y la segunda Castellano. NewTV no publica la región en el master y
 * algunos títulos vienen al revés; esos casos comprobados se corrigen por `netflix_id`.
 *
 * Este módulo tiene un espejo en el cliente Android (`core/model/Idiomas.kt`) para que las
 * pistas que vienen "desnudas" del propio HLS (sin pasar por el backend) también se traduzcan.
 */

/** ISO 639-2 (tres letras) → nombre en español. */
const MAPA: Record<string, string> = {
  spa: 'Español',
  eng: 'Inglés',
  fra: 'Francés',
  fre: 'Francés',
  por: 'Portugués',
  ita: 'Italiano',
  rus: 'Ruso',
  tur: 'Turco',
  ces: 'Checo',
  cze: 'Checo',
  hun: 'Húngaro',
  hin: 'Hindi',
  fil: 'Filipino',
  tgl: 'Filipino',
  tam: 'Tamil',
  tel: 'Telugu',
  ara: 'Árabe',
  ben: 'Bengalí',
  jpn: 'Japonés',
  kor: 'Coreano',
  zho: 'Chino',
  chi: 'Chino',
  deu: 'Alemán',
  ger: 'Alemán',
  nld: 'Neerlandés',
  dut: 'Neerlandés',
  swe: 'Sueco',
  nor: 'Noruego',
  dan: 'Danés',
  fin: 'Finés',
  pol: 'Polaco',
  ron: 'Rumano',
  rum: 'Rumano',
  ell: 'Griego',
  gre: 'Griego',
  heb: 'Hebreo',
  vie: 'Vietnamita',
  tha: 'Tailandés',
  ind: 'Indonesio',
  msa: 'Malayo',
  may: 'Malayo',
  urd: 'Urdu',
  fas: 'Persa',
  per: 'Persa',
  ukr: 'Ucraniano',
  bul: 'Búlgaro',
  hrv: 'Croata',
  srp: 'Serbio',
  slk: 'Eslovaco',
  slo: 'Eslovaco',
  slv: 'Esloveno',
  cat: 'Catalán',
  eus: 'Euskera',
  baq: 'Euskera',
  glg: 'Gallego',
  und: 'Original',
};

/** ISO 639-1 (dos letras) → 639-2 para normalizar. */
const DE_ISO1: Record<string, string> = {
  es: 'spa', en: 'eng', fr: 'fra', pt: 'por', it: 'ita', ru: 'rus', tr: 'tur',
  cs: 'ces', hu: 'hun', hi: 'hin', ta: 'tam', te: 'tel', ar: 'ara', bn: 'ben',
  ja: 'jpn', ko: 'kor', zh: 'zho', de: 'deu', nl: 'nld', sv: 'swe', no: 'nor',
  da: 'dan', fi: 'fin', pl: 'pol', ro: 'ron', el: 'ell', he: 'heb', vi: 'vie',
  th: 'tha', id: 'ind', ms: 'msa', ur: 'urd', fa: 'fas', uk: 'ukr', bg: 'bul',
  hr: 'hrv', sr: 'srp', sk: 'slk', sl: 'slv', ca: 'cat', eu: 'eus', gl: 'glg',
};

/** Normaliza un tag de idioma cualquiera ("es-419", "eng", "en") al ISO 639-2. */
export function normalizarISO(tag: string): string {
  const t = String(tag || '').toLowerCase().trim();
  if (!t) return 'und';
  const dos = t.slice(0, 2);
  if (t.length === 2 && DE_ISO1[t]) return DE_ISO1[t];
  if (t.length >= 3 && MAPA[t.slice(0, 3)]) return t.slice(0, 3);
  if (DE_ISO1[dos]) return DE_ISO1[dos];
  return t.slice(0, 3);
}

/** Algunos masters de NetMirror omiten LANGUAGE, pero conservan NAME. */
function idiomaDesdeNombre(nombre: string): string {
  const n = String(nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/(?:spanish|espanol|latino|castell)/.test(n)) return 'spa';
  if (/(?:english|ingles)/.test(n)) return 'eng';
  if (/(?:french|frances)/.test(n)) return 'fra';
  if (/(?:portuguese|portugues)/.test(n)) return 'por';
  if (/(?:italian|italiano)/.test(n)) return 'ita';
  if (/(?:german|aleman)/.test(n)) return 'deu';
  if (/(?:japanese|japones)/.test(n)) return 'jpn';
  if (/(?:korean|coreano)/.test(n)) return 'kor';
  return 'und';
}

/** Nombre en español de un idioma ISO. Devuelve el propio código si no lo conocemos. */
export function nombreEsp(iso: string): string {
  return MAPA[normalizarISO(iso)] || iso;
}

export interface PistaAudio {
  lang: string;       // ISO 639-2, ya normalizado
  name_es: string;    // etiqueta en español a mostrar al usuario
  uri: string;        // URL del m3u8 de esta pista de audio
  default: boolean;   // true si es la que reproduce por defecto
}

interface EntradaBruta {
  language: string;   // como venga (puede ser "spa", "eng", "es-ES"...)
  name?: string;      // como lo etiquete el proveedor
  uri: string;
}

/**
 * Convierte la lista cruda de #EXT-X-MEDIA TYPE=AUDIO a pistas normalizadas.
 *
 * Regla observada en NewTV para `spa`: la primera pista española es Latino; cuando existe una
 * segunda, es Castellano. Una única pista `spa` también se rotula explícitamente como Latino:
 * además de ser más claro para el cliente, permite aplicar el requisito de catálogo sin inferirlo
 * a partir de una etiqueta ambigua como "Español".
 *
 * La primera pista `spa` (o `eng` si no hay español) queda marcada `default: true`.
 */
const CASTELLANO_PRIMERO = new Set([
  '70047102', // Shrek Tercero: pista 24 castellano, pista 25 latino.
]);

/** Corrige metadata histórica ya guardada cuando NewTV publica ambos dialectos sólo como `spa`. */
export function corregirDialectosNetmirror<T extends { lang?: string; name_es?: string; default?: boolean }>(
  pistas: T[],
  netflixId: string,
): T[] {
  if (!CASTELLANO_PRIMERO.has(String(netflixId))) return pistas;
  const totalSpa = pistas.filter(p => normalizarISO(String(p.lang || '')) === 'spa').length;
  if (totalSpa < 2) return pistas;
  let indiceSpa = 0;
  return pistas.map(p => {
    if (normalizarISO(String(p.lang || '')) !== 'spa') return p;
    const indice = indiceSpa++;
    return {
      ...p,
      name_es: indice === 0 ? 'Español (Castellano)'
        : indice === 1 ? 'Español (Latino)'
        : 'Español',
      default: indice === 1,
    };
  });
}

export function traducirYNormalizar(brutas: EntradaBruta[], netflixId = ''): PistaAudio[] {
  const iso = brutas.map(b => {
    const normalizado = normalizarISO(b.language);
    return normalizado === 'und' ? idiomaDesdeNombre(b.name || '') : normalizado;
  });
  const cuentaSpa = iso.filter(x => x === 'spa').length;
  const castellanoPrimero = cuentaSpa >= 2 && CASTELLANO_PRIMERO.has(String(netflixId));
  let indiceSpa = 0;

  const pistas: PistaAudio[] = brutas.map((b, i) => {
    const lang = iso[i];
    let name_es: string;
    if (lang === 'spa') {
      if (indiceSpa === 0) {
        name_es = castellanoPrimero ? 'Español (Castellano)' : 'Español (Latino)';
      } else if (indiceSpa === 1) {
        name_es = castellanoPrimero ? 'Español (Latino)' : 'Español (Castellano)';
      } else {
        name_es = 'Español';
      }
      indiceSpa++;
    } else {
      name_es = nombreEsp(lang);
    }
    return { lang, name_es, uri: b.uri, default: false };
  });

  // Elegir default: Latino comprobado, si no primera spa, luego inglés o primera del master.
  const iLatino = pistas.findIndex(p => p.name_es === 'Español (Latino)');
  const iSpa = pistas.findIndex(p => p.lang === 'spa');
  const iEng = pistas.findIndex(p => p.lang === 'eng');
  const iDefault = iLatino >= 0 ? iLatino : iSpa >= 0 ? iSpa : iEng >= 0 ? iEng : 0;
  if (pistas[iDefault]) pistas[iDefault].default = true;

  return corregirDialectosNetmirror(pistas, netflixId);
}

/**
 * Regla única de publicación para NetMirror. Se exige la etiqueta normalizada, no sólo `spa`,
 * porque una fila histórica llamada "Español" no demuestra qué variante contiene y debe volver
 * a escanearse antes de anunciarse como latino.
 */
export function tieneEspanolLatino(
  pistas: Array<{ lang?: string; name_es?: string }> | null | undefined,
): boolean {
  return Array.isArray(pistas) && pistas.some((p) =>
    p?.lang === 'spa' && /espa(?:ñ|n)ol\s*\(latino\)/i.test(String(p?.name_es || '')),
  );
}
