/**
 * Utilidades de normalización de texto compartidas por búsqueda y scraping.
 * Antes duplicadas inline en catalogService y realScraperService.
 */

// Marcas diacríticas combinantes (U+0300–U+036F) que quedan tras normalizar en NFD.
const DIACRITICS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');

/**
 * Minúsculas + sin acentos (NFD). Para comparación y scoring de relevancia.
 * NO elimina espacios ni puntuación.
 */
export function normalizeTitle(input: string | null | undefined): string {
  return (input || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '');
}

/**
 * Clave canónica: normaliza y elimina todo lo no alfanumérico.
 * Para agrupar/deduplicar títulos equivalentes (p. ej. "Spider-Man" == "spiderman").
 */
export function canonicalTitle(input: string | null | undefined): string {
  return normalizeTitle(input).replace(/[^a-z0-9]/g, '').trim();
}

/**
 * Clave de BÚSQUEDA de una ficha: el título mostrado seguido de sus otros nombres
 * conocidos (título original y alias de la fuente), normalizados y sin repeticiones.
 *
 * Es lo que se guarda en `media_items.title_normalized`, la única columna sobre la que
 * busca el RPC `search_media`. Incluir los otros nombres es lo que permite encontrar
 * "Avengers 2: Era de Ultrón" escribiendo "vengadores", o una película por su título
 * original en inglés. El título mostrado va PRIMERO para que el ranking por prefijo
 * (LIKE 'q%') siga premiando el nombre principal.
 */
export function searchIndexKey(
  title: string | null | undefined,
  originalTitle?: string | null,
  aliases?: string[] | null
): string {
  const parts = [title, originalTitle, ...(aliases || [])]
    .map(t => normalizeTitle(t).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const unique = parts.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  return unique.join(' ').trim();
}

/**
 * Deduplica una lista de nombres por su forma normalizada (minúsculas, sin acentos, espacios
 * colapsados), conservando la PRIMERA aparición con su grafía original. Sirve para limpiar el
 * array `aliases` —donde conviven el título scrapeado, el de TMDB y las variantes regionales—
 * sin perder las variantes legibles ni ensuciar el índice con repeticiones.
 */
export function dedupeTitles(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    const trimmed = n.trim();
    const key = normalizeTitle(trimmed).replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Convierte un texto en slug URL-safe: sin acentos, minúsculas, separado por guiones.
 */
export function slugify(input: string | null | undefined): string {
  return normalizeTitle(input).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Reconstruye el título y el AÑO originales a partir del id/slug de la fuente.
 * FuegoCine antepone `YYYY-MM-` y añade `-YYYY-html`; TioPlus usa el slug pelado.
 * Ej.: `2025-04-los-vengadores-era-de-ultron-2015-html` → { title: "los vengadores era de ultron", year: "2015" }.
 *
 * Es la ÚNICA fuente del año cuando `release_date` viene vacío (FuegoCine lo deja así), y la
 * comparten el enrichment (para no emparejar a ciegas) y repairCatalog (para re-resolver).
 */
export function sourceTitleFromSlug(id: string | null | undefined): { title: string; year?: string } {
  let slug = String(id || '').trim().toLowerCase();
  if (!slug) return { title: '' };

  slug = slug.replace(/^fc-/, '').replace(/-html$/, '').replace(/^\d{4}-\d{2}-/, '');

  let year: string | undefined;
  const yearMatch = slug.match(/-(\d{4})$/);
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    if (y >= 1900 && y <= 2100) {
      year = yearMatch[1];
      slug = slug.slice(0, -5);
    }
  }

  return { title: slug.replace(/-/g, ' ').trim(), year };
}

/** Solo el año embebido en el id/slug de la fuente, o `undefined`. Atajo de sourceTitleFromSlug. */
export function yearFromSlug(id: string | null | undefined): string | undefined {
  return sourceTitleFromSlug(id).year;
}
