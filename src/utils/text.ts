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
 * Convierte un texto en slug URL-safe: sin acentos, minúsculas, separado por guiones.
 */
export function slugify(input: string | null | undefined): string {
  return normalizeTitle(input).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
