-- Migración 013 — Lo que el aparato mide y el catálogo no puede saber solo.
--
-- El catálogo sondea sus hosts desde una función de Vercel: una vez, desde un centro de datos, y
-- guarda el resultado en `servers.kbps`. Ese dato decide el orden de la lista, y se ha demostrado
-- poco fiable. Medido el 26/08/2026 sobre una ficha real de archive.org:
--
--     lo que dice el catálogo    kbps: 82        (y kbps_necesarios: 520)
--     lo que midió un aparato    2,0 MB/s        = 16 000 kbps
--
-- No es un fallo del sondeo: es que mide otra red, en otro momento. archive.org daba 1,33 MB/s por
-- la mañana y 35 KB/s por la tarde, y eso ya está escrito en `streamSorter`.
--
-- Estas tres columnas son la señal contraria: lo que ese host dio en una reproducción de verdad,
-- en la red de alguien. Con suficientes, el catálogo puede ordenar por lo que de verdad le pasa a
-- la gente en vez de por lo que le pasó una vez a una lambda.

ALTER TABLE playback_events
  -- Caudal sostenido durante la reproducción, en kbps.
  ADD COLUMN IF NOT EXISTS kbps_medidos bigint,

  -- Cuántas veces hubo que reabrir la conexión porque el caudal se derrumbó.
  --
  -- Es la señal más afilada de las tres, y no la tiene ninguna otra columna. Un host que estrangula
  -- —archive.org deja la segunda conexión en 48 KB/s, medido y reproducible— no se delata ni en el
  -- TTFB, ni en `kbps`, ni en `stalls`: precisamente porque las reconexiones existen para que eso
  -- no llegue a ser un atasco. Aquí sí se ve.
  ADD COLUMN IF NOT EXISTS reconexiones integer,

  -- Con cuántas conexiones a la vez se acabó trabajando contra ese host.
  --
  -- No hay un número bueno para todos y por eso se aprende: archive.org empeora con dos (1,3 MB/s
  -- entre cuatro frente a 2,0 con una) y vimeos escala al doble con seis. Lo que cada aparato
  -- aprende por su cuenta puede acabar compartiéndose por aquí.
  ADD COLUMN IF NOT EXISTS conexiones integer;
