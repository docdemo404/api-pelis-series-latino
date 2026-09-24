# Reglas para agentes (Codex, Antigravity y demás)

Las reglas de este repo están en **[CLAUDE.md](./CLAUDE.md)** — léelas antes de tocar nada,
especialmente la sección de **base de datos**.

Resumen crítico: la base se ha caído dos veces por crawlers glotones. **NUNCA leas una tabla
entera** (`SELECT *`/`.select()` sin `WHERE`/`.eq`/`.in`/`LIMIT`); consulta por claves. Hay un
**presupuesto diario de lecturas compartido** (`src/db/presupuestoLecturas.ts`) que auto-aborta los
jobs que se pasan — no lo desactives, arregla la consulta. Todo el acceso va por
`getSupabaseAdmin()` (`src/db/compat.ts`); no crees clientes de base sueltos.
