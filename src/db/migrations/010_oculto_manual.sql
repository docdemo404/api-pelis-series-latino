-- Migración 010 — Esconder un título A MANO desde el panel.
--
-- Hasta ahora la visibilidad la decidía entera la máquina: `has_streams` lo calcula
-- `veredictoDisponibilidad` y lo reescriben el crawl, los barridos y las reparaciones. O sea que
-- no había forma de decir «este título no lo quiero en la app» — y si se ponía `has_streams` a
-- false a mano, la siguiente corrida que encontrara un enlace bueno lo volvía a anunciar.
--
-- Es el mismo problema que las urls puestas a mano (migración 009): una decisión de una persona
-- no puede vivir en una celda que un barrido recalcula. Así que va en su propia columna, y la
-- escribe SOLO el panel.
--
--   NULL / false → la visibilidad la deciden las comprobaciones de siempre
--   true         → escondido a mano; no sale en listados, home ni búsqueda, tenga lo que tenga
--
-- Es seguro ejecutarlo más de una vez y no toca ningún dato existente.

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS oculto_manual BOOLEAN;

COMMENT ON COLUMN media_items.oculto_manual IS
  'true = escondido a mano desde el panel, por encima de cualquier comprobación automática. Lo escribe solo el panel; ningún barrido lo toca.';

-- Los escondidos son un puñado: un índice parcial cuesta nada y hace instantáneo el filtro.
CREATE INDEX IF NOT EXISTS idx_media_oculto_manual
  ON media_items (oculto_manual)
  WHERE oculto_manual IS TRUE;
