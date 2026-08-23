-- Migración 009 — El libro de lo puesto a mano.
--
-- Las urls que una persona pega por el panel viven dentro de `servers` y `seasons`, o sea en la
-- MISMA celda que los servidores que trae el rastreo. Y esas dos columnas se reemplazan enteras
-- en cada escritura —el crawl, la persistencia de enlaces, la de capítulos, los barridos—, así
-- que cada escritor tiene que acordarse de rescatar lo manual antes de guardar. Se ha olvidado
-- cuatro veces, cada una por una puerta distinta, y el usuario lo ha reportado las cuatro como
-- «los datos de la fuente propia no persisten».
--
-- El problema no es ninguno de esos escritores: es que un dato que NADIE REGENERA comparta celda
-- con datos que se regeneran solos. Un servidor scrapeado que se pierde vuelve en la siguiente
-- pasada; una url pegada a mano no la redescubre nadie.
--
-- Esta columna es la copia que solo escribe el panel. La API la usa al LEER para devolver a su
-- sitio lo que la fila haya perdido, así que a partir de ahora ningún escritor —ni los que ya hay
-- ni los que se añadan, ni un UPDATE a mano en este mismo editor— puede hacer desaparecer una url
-- de la fuente propia.
--
-- Es seguro ejecutarlo más de una vez y no toca ningún dato existente.

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS manual_servers JSONB;

COMMENT ON COLUMN media_items.manual_servers IS
  'Copia de las urls de la FUENTE PROPIA (source_id=manual), a nivel de ficha y de capítulo. La escribe solo el panel; la API la usa para restaurar lo que otros escritores pisen. Ver src/services/manualLedger.ts.';

-- Solo las filas que tienen algo puesto a mano: son un puñado sobre decenas de miles, así que un
-- índice parcial es diminuto y hace instantánea la auditoría «¿le falta a alguien su url?».
CREATE INDEX IF NOT EXISTS idx_media_manual_servers
  ON media_items ((manual_servers IS NOT NULL))
  WHERE manual_servers IS NOT NULL;
