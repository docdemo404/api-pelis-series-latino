/**
 * EL ACCESO A LA BASE DE DATOS (Turso / libSQL), con el nombre de siempre.
 *
 * El archivo se sigue llamando `supabaseService` y sigue exportando `supabase` y
 * `getSupabaseAdmin()` porque diecinueve archivos los importan así, y lo que cambió en la mudanza
 * de septiembre de 2026 fue la base, no el código que la usa: `src/db/compat.ts` habla la misma
 * sintaxis que supabase-js y por debajo manda SQL a Turso. Ver allí qué subconjunto está.
 *
 * Ya no hay dos clientes (anon / service role): el token de Turso lo puede todo, así que
 * `getSupabaseAdmin()` devuelve el mismo cliente. Se conserva para no tocar a quien lo llama y
 * porque el nombre sigue diciendo la intención: «esto escribe».
 */
import { ClienteCompat } from '../db/compat';

export const supabase = new ClienteCompat();

export function getSupabaseAdmin(): ClienteCompat {
  return supabase;
}
