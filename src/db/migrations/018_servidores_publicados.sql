-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- LOS SERVIDORES, COMO FILAS. Para poder preguntar por ellos sin bajarse el catálogo entero.
--
-- Los servidores viven dentro de `media_items.servers` y, en las series, otra vez dentro de
-- `seasons[].episodes[].servers`. Eso está bien para servir una ficha, pero convierte cualquier
-- pregunta sobre servidores en «descárgate las 10.375 fichas y búscalo tú».
--
-- Y eso es exactamente lo que hacían los barridos de `verificar.yml`: tres pasadas, cada una
-- bajándose la tabla con `servers` y `seasons` dentro —92 MB— doce veces al día. Unos 100 GB al
-- mes contra un plan de 5 GB. El proyecto acabó restringido por `exceed_egress_quota`, la API
-- REST empezó a contestar 402 a todo y la app se quedó enseñando un catálogo vacío.
--
-- Con esta vista, «los 400 enlaces con el sello más viejo» es una consulta que devuelve 31 KB.
--
-- ── POR QUÉ UNA VISTA Y NO UNA TABLA ──────────────────────────────────────────────────────────
--
-- Porque una copia habría que mantenerla al día, y quien escribe los servidores son ocho scripts
-- distintos más la propia API. Una vista no se desincroniza nunca: es la misma fila, mirada de
-- otra forma. Medido sobre el catálogo real, expandir las 129.948 filas cuesta ~1 s, y estos
-- barridos corren cada dos horas.
--
-- ── LAS FECHAS VAN TIPADAS, Y NO ES UN DETALLE ────────────────────────────────────────────────
--
-- `verified_at` se guarda como texto ISO dentro del JSON. Comparar ese texto contra
-- `now()::text` parece que funciona y falla en silencio: Postgres escribe la hora con un espacio
-- donde el ISO lleva una `T`, y la `T` ordena por encima del espacio. Dos sellos del MISMO día
-- se comparan al revés. Aquí se convierte a `timestamptz` una sola vez, con guarda por si algún
-- día entra un valor con otra forma: los 92.075 sellos que hay hoy parsean todos.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace view public.servidores_publicados as
select
  m.id                   as media_id,
  m.type                 as media_type,
  m.title                as media_title,
  null::text             as season_number,
  null::text             as episode_number,
  sv->>'embed_url'       as embed_url,
  sv->>'direct_stream'   as direct_stream,
  sv->>'status'          as status,
  -- El dominio, ya recortado. Lo piden los dos barridos y calcularlo en SQL evita que cada uno
  -- se invente su propia versión: una url interna de la API (`/api/v1/netmirror/...`) no tiene
  -- host y cae en la cadena vacía, que es el mismo cajón único que le daba `hostDe` en el script.
  split_part(regexp_replace(sv->>'embed_url', '^https?://(www\.)?', ''), '/', 1) as host,
  case when sv->>'verified_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
       then (sv->>'verified_at')::timestamptz end            as verified_at,
  case when sv->>'fallos_entrega' ~ '^[0-9]+$'
       then (sv->>'fallos_entrega')::int end                 as fallos_entrega
from public.media_items m,
     lateral jsonb_array_elements(coalesce(m.servers, '[]'::jsonb)) sv

union all

select
  m.id,
  m.type,
  m.title,
  t.value->>'season_number',
  e.value->>'episode_number',
  sv->>'embed_url',
  sv->>'direct_stream',
  sv->>'status',
  split_part(regexp_replace(sv->>'embed_url', '^https?://(www\.)?', ''), '/', 1),
  case when sv->>'verified_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
       then (sv->>'verified_at')::timestamptz end,
  case when sv->>'fallos_entrega' ~ '^[0-9]+$'
       then (sv->>'fallos_entrega')::int end
from public.media_items m,
     lateral jsonb_array_elements(coalesce(m.seasons, '[]'::jsonb)) t,
     lateral jsonb_array_elements(coalesce(t.value->'episodes', '[]'::jsonb)) e,
     lateral jsonb_array_elements(coalesce(e.value->'servers', '[]'::jsonb)) sv;

-- Solo la usan los barridos, que hablan con service_role. Una vista de Postgres corre con los
-- permisos de su dueño y se salta RLS, así que no se deja abierta a las claves públicas.
revoke all on public.servidores_publicados from anon, authenticated;
grant select on public.servidores_publicados to service_role;

comment on view public.servidores_publicados is
  'Los servidores de media_items (ficha y episodios) como filas. Para barridos que preguntan por servidores sin descargar el catálogo. Ver 018.';


-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- UN EMBED, UNA FILA. Lo que necesita `--verificar` para elegir a quién preguntar.
--
-- El mismo embed aparece en muchas fichas y en muchos episodios, y lo que decide si hay que
-- volver a mirarlo es su sello MÁS FRESCO, no el de una aparición cualquiera. Agrupar eso en
-- JavaScript obligaba a tener las 129.948 filas delante; aquí lo hace Postgres y devuelve 79.141.
--
-- `fichas` viene dentro a propósito: quien pone un veredicto necesita saber QUÉ fichas hay que
-- reescribir, y sin esta columna haría falta una segunda consulta por cada embed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace view public.embeds_publicados as
select
  embed_url,
  max(verified_at)             as sello,
  count(*)                     as apariciones,
  array_agg(distinct media_id) as fichas
from public.servidores_publicados
where embed_url is not null
  and direct_stream is not null
group by embed_url;

revoke all on public.embeds_publicados from anon, authenticated;
grant select on public.embeds_publicados to service_role;

comment on view public.embeds_publicados is
  'Un embed publicado por fila, con su sello más fresco y las fichas que lo llevan. Para --verificar. Ver 018.';


-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- UNA MUESTRA POR HOST. Lo que necesita `--entrega`.
--
-- Ese barrido no comprueba servidores: comprueba HOSTS, y le basta con cuatro ejemplos de cada
-- uno. Bajarse el catálogo entero para acabar quedándose con cuatro por host era el gasto más
-- absurdo de los tres.
--
-- Se guardan OCHO y no cuatro para que el script pueda filtrar por frescura del sello y aún le
-- queden cuatro. Y se ordena por sello descendente, así que si el cuarto ya está caducado es que
-- no hay cuatro frescos — la respuesta es exacta, no una aproximación.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace view public.muestra_por_host as
select media_id, media_type, media_title, embed_url, direct_stream, status, verified_at, host, puesto
from (
  select
    sp.*,
    row_number() over (partition by host order by verified_at desc nulls last) as puesto
  from public.servidores_publicados sp
  where embed_url is not null
    and direct_stream is not null
) q
where puesto <= 8;

revoke all on public.muestra_por_host from anon, authenticated;
grant select on public.muestra_por_host to service_role;

comment on view public.muestra_por_host is
  'Hasta ocho servidores de ejemplo por host, el sello más fresco primero. Para --entrega. Ver 018.';
