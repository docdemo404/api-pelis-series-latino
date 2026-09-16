-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- LOS CAPÍTULOS COMO FILAS, Y LOS QUE TOCA COMPROBAR YA ORDENADOS.
--
-- `repairCatalog --episodios` corre nueve veces al día y hasta ahora se bajaba TODAS las series
-- con `seasons` dentro —79 MB la última vez que se midió— para quedarse con 4.000 capítulos. Son
-- unos 700 MB al día contra una cuota de 5 GB al mes: solo este barrido la agotaba en una semana.
-- Es el mismo patrón que la 018 quitó de `--verificar`: decidir en JavaScript lo que Postgres
-- puede contestar solo.
--
-- Dos vistas. `capitulos_publicados` es cada capítulo de cada serie con lo poco que hace falta para
-- juzgarlo: la ficha, si se ve hoy, y su sello `checked_at`. `capitulos_por_comprobar` filtra los
-- que no tienen sello o lo tienen de hace más de siete días —el mismo plazo que tenía el script—
-- y añade `faltan`, cuántos le quedan a su serie, que es la clave del orden «serie por serie,
-- las que menos les falta primero». Con eso la consulta del barrido es un ORDER BY y un LIMIT, y
-- lo que baja son 4.000 filas de sesenta bytes.
--
-- No se pierde nada al reemplazarlas: una vista no guarda datos, es una consulta con nombre.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

drop view if exists public.capitulos_por_comprobar;
drop view if exists public.capitulos_publicados;

create or replace view public.capitulos_publicados as
select
  m.id                    as media_id,
  m.title                 as media_title,
  m.has_streams           as has_streams,
  case when t.value->>'season_number' ~ '^[0-9]+$'
       then (t.value->>'season_number')::int end             as season_number,
  case when e.value->>'episode_number' ~ '^[0-9]+$'
       then (e.value->>'episode_number')::int end            as episode_number,
  case when e.value->>'checked_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
       then (e.value->>'checked_at')::timestamptz end        as checked_at
from public.media_items m,
     lateral jsonb_array_elements(coalesce(m.seasons, '[]'::jsonb)) t,
     lateral jsonb_array_elements(coalesce(t.value->'episodes', '[]'::jsonb)) e
where m.type = 'tvseries';

revoke all on public.capitulos_publicados from anon, authenticated;
grant select on public.capitulos_publicados to service_role;

comment on view public.capitulos_publicados is
  'Cada capítulo de cada serie como fila, con su sello checked_at. Para barridos que preguntan por capítulos sin descargar seasons. Ver 020.';

create or replace view public.capitulos_por_comprobar as
select
  c.media_id,
  c.media_title,
  c.has_streams,
  c.season_number,
  c.episode_number,
  c.checked_at,
  count(*) over (partition by c.media_id) as faltan
from public.capitulos_publicados c
where c.season_number is not null
  and c.episode_number is not null
  and (c.checked_at is null or c.checked_at < now() - interval '7 days');

revoke all on public.capitulos_por_comprobar from anon, authenticated;
grant select on public.capitulos_por_comprobar to service_role;

comment on view public.capitulos_por_comprobar is
  'Capítulos sin sello o con sello de más de 7 días, con cuántos le faltan a su serie. Lo que pide --episodios. Ver 020.';

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Y LOS SERVIDORES DE FICHA QUE AÚN NO TIENEN VÍDEO DIRECTO, para `refreshCatalog --direct`.
--
-- Ese repaso se bajaba todas las fichas con `servers` (~10 MB, tres veces al día) para quedarse
-- con los servidores sin `direct_stream` de hosts que sí sabemos extraer. Lo primero lo decide
-- Postgres aquí; lo segundo sigue siendo JavaScript (`mereceRepasoDeExtraccion`, que mira la
-- política del host), pero ya sobre unos miles de filas de cien bytes, no sobre el catálogo.
-- Solo servidores de la ficha, no de capítulos: es lo que ese repaso miraba.
-- ───────────────────────────────────────────────────────────────────────────────────────────────

drop view if exists public.servidores_sin_directo;

create or replace view public.servidores_sin_directo as
select
  m.id                    as media_id,
  m.type                  as media_type,
  m.streams_updated_at    as streams_updated_at,
  sv->>'embed_url'        as embed_url
from public.media_items m,
     lateral jsonb_array_elements(coalesce(m.servers, '[]'::jsonb)) sv
where coalesce(sv->>'embed_url', '') <> ''
  and coalesce(sv->>'direct_stream', '') = '';

revoke all on public.servidores_sin_directo from anon, authenticated;
grant select on public.servidores_sin_directo to service_role;

comment on view public.servidores_sin_directo is
  'Servidores de ficha (no de capítulo) con embed y sin direct_stream. Lo que repasa refreshCatalog --direct. Ver 020.';
