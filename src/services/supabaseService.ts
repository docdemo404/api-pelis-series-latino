import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kgeytmocuitbchpdcoad.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtnZXl0bW9jdWl0YmNocGRjb2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1OTY1NTQsImV4cCI6MjEwMDE3MjU1NH0._t2cRnkx_BCXP-J7TaK3Iymhk_bod2Xb5RlzsqSScxg';

// Cliente compartido de Supabase (anon). La capa de acceso a datos vive en CatalogService.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Cliente para jobs de background (scripts/refreshCatalog.ts): usa la
 * SUPABASE_SERVICE_ROLE_KEY si está disponible (necesaria para escribir cuando la
 * tabla tiene RLS activado). Sin ella, degrada al cliente anon.
 */
export function getSupabaseAdmin() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return serviceKey ? createClient(SUPABASE_URL, serviceKey) : supabase;
}
