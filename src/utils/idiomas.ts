/**
 * Traducción de códigos ISO 639 al nombre en español + regla especial de `spa` (Latino/Castellano).
 *
 * NetMirror devuelve nombres en inglés ("Spanish", "French", "English") y el reproductor mostraba
 * eso literalmente. Regla del usuario: SIEMPRE en español, y cuando hay varias pistas `spa`, la
 * primera pasa a "Español (Latino)" y la segunda a "Español (Castellano)" (medido: el orden del
 * master respeta esa convención). Con una sola pista `spa`, se etiqueta a secas "Español".
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
 * Regla del usuario para `spa`:
 *   - 1 pista `spa`  → "Español" a secas.
 *   - ≥2 pistas `spa` → la 1ª "Español (Latino)", la 2ª "Español (Castellano)", el resto "(N)".
 *
 * La primera pista `spa` (o `eng` si no hay español) queda marcada `default: true`.
 */
export function traducirYNormalizar(brutas: EntradaBruta[]): PistaAudio[] {
  const iso = brutas.map(b => normalizarISO(b.language));
  const cuentaSpa = iso.filter(x => x === 'spa').length;
  let indiceSpa = 0;

  const pistas: PistaAudio[] = brutas.map((b, i) => {
    const lang = iso[i];
    let name_es: string;
    if (lang === 'spa') {
      if (cuentaSpa === 1) {
        name_es = 'Español';
      } else if (indiceSpa === 0) {
        name_es = 'Español (Latino)';
      } else if (indiceSpa === 1) {
        name_es = 'Español (Castellano)';
      } else {
        name_es = `Español (${indiceSpa + 1})`;
      }
      indiceSpa++;
    } else {
      name_es = nombreEsp(lang);
    }
    return { lang, name_es, uri: b.uri, default: false };
  });

  // Elegir default: primera spa, si no primera eng, si no la primera del master.
  const iSpa = pistas.findIndex(p => p.lang === 'spa');
  const iEng = pistas.findIndex(p => p.lang === 'eng');
  const iDefault = iSpa >= 0 ? iSpa : iEng >= 0 ? iEng : 0;
  if (pistas[iDefault]) pistas[iDefault].default = true;

  return pistas;
}
