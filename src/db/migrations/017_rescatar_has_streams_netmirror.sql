-- Migración 017 — Rescatar has_streams para las fichas con NetMirror.
--
-- 3.019 fichas del catalogo tienen netflix_id en netmirror_cache (osea, netmirror puede
-- reproducirlas via HLS multi-audio). Pero muchas de esas fichas quedaron marcadas
-- `has_streams = false` cuando el catalogo evaluo su disponibilidad SIN esa fuente. El
-- efecto: no aparecen en listados ni busquedas, y el cliente Android no llega a abrirlas
-- para que se re-evaluen — ciclo vicioso.
--
-- Este UPDATE unico las pone `has_streams = true`. En cuanto la app abra cualquiera de
-- ellas, `getStreams` re-evalua y confirma (o degrada, si algun dia netmirror muere) — o
-- sea que no perpetuamos un estado erroneo, solo desbloqueamos la primera apertura.

UPDATE media_items SET has_streams = true
WHERE has_streams = false
  AND tmdb_id IN (SELECT tmdb_id FROM netmirror_cache WHERE netflix_id IS NOT NULL);
