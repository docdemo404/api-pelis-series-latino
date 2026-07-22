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
 * Convierte un texto en slug URL-safe: sin acentos, minúsculas, separado por guiones.
 */
export function slugify(input: string | null | undefined): string {
  return normalizeTitle(input).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
