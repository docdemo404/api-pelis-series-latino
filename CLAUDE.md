# Reglas del proyecto — LÉELAS antes de tocar la base de datos

En este repo trabajan muchas manos (Claude, Codex, Antigravity y personas). La base se ha
**agotado y caído dos veces** por crawlers/automatizaciones glotonas. La cuota que se agota es de
**FILAS leídas/escritas al mes** (Turso y D1 cobran por fila leída), y **un `SELECT` sin filtro
escanea —y "lee"— la tabla ENTERA**. Sé disciplinado con esto:

## Lecturas (lo que tumbó el catálogo el 2026-09-24: 572M/500M)
1. **NUNCA** hagas `SELECT *` / `.select()` de una tabla completa (sin `WHERE` / `.eq` / `.in` /
   `LIMIT`). Consulta **por claves**: `.eq(...)`, `.in('id', [...])` en tandas de ~400, con `.limit()`.
2. **NUNCA** cargues una tabla entera en memoria para deduplicar. Consulta solo por los
   **candidatos de esa corrida**. Ejemplo correcto: `scripts/refreshCatalog.ts` (`--saltar-guardados`).
3. Hay un **presupuesto diario de lecturas COMPARTIDO** entre todos los procesos
   (`src/db/presupuestoLecturas.ts`, en Redis, ~15M/día). Si un job lee de más, **se auto-aborta**.
   No lo desactives ni lo subas para "que pase": arregla la consulta.
4. El acceso a la base pasa por `src/db/contadorEscrituras.ts` (envuelve el cliente). Al final de
   cada script imprime `[lecturas]`/`[escrituras]` con cuánto gastó. Si ves `[lectura-grande]` o
   `[scan-completo]` en los logs de GitHub Actions, ESE es el glotón: arréglalo.
5. Si filtras por una columna nueva, **añade su índice** en `src/db/turso/esquema.sql` (si no, la
   consulta escanea toda la tabla).

## Escrituras
- Espacia los barridos; no reescribas filas que no cambiaron (la guarda ya está en `compat.ts`).
- Mira `catalog_writable` en `/api/v1/panel` antes de diagnosticar "no escribe".

## General
- Rama única `main`; siempre commit + `vercel --prod` y verificar en producción.
- No fusionar servidores/fichas por título; exigir año/metadata.
- El acceso a la base es SOLO por `getSupabaseAdmin()` (capa compat en `src/db/compat.ts`). No
  crees clientes libSQL sueltos: te saltarías el contador y el presupuesto.
