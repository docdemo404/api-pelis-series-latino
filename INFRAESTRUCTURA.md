# Qué tienes que hacer tú

Dos tareas. **Las dos gratis y para siempre** (no piden tarjeta). Unos 15 minutos en total.

El código ya está hecho y desplegado. Hasta que hagas esto, la API funciona igual que ahora: lo
nuevo está apagado y no rompe nada.

Ve de arriba abajo. Cada bloque de comandos se copia y se pega tal cual.

---

## Tarea 1 · Upstash — 5 minutos

> Arregla el contador de tránsito, que **hoy no funciona**. Sin él, el tope de 80 GB no salta
> nunca y puedes pasarte del plan sin enterarte.

**1.** Entra en <https://console.upstash.com> y regístrate con Google (no pide tarjeta).

**2.** Pulsa **Create Database**. Ponle el nombre que quieras, deja todo lo demás como viene y
crea.

**3.** Baja hasta la sección **REST API**. Verás dos valores. Déjalos a mano:
- `UPSTASH_REDIS_REST_URL` → empieza por `https://`
- `UPSTASH_REDIS_REST_TOKEN` → una cadena larga

**4.** En la carpeta del proyecto, ejecuta esto. Te pedirá pegar el valor de la **URL**:

```bash
npx vercel env add UPSTASH_REDIS_REST_URL production
```

**5.** Ahora el token. Te pedirá pegar el valor del **TOKEN**:

```bash
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
```

✅ Tarea 1 lista.

---

## Tarea 2 · Cloudflare — 10 minutos

> Es lo que quita el techo de ancho de banda. Cloudflare no cobra por el tráfico de salida, así
> que el vídeo pesado deja de gastar tu plan de Vercel.

**1.** Regístrate en <https://dash.cloudflare.com/sign-up> (el plan gratuito vale; no pide
tarjeta).

**2.** Inventa una contraseña larga, por ejemplo `mi-clave-secreta-2026-pelis-xyz`. **Apúntala**,
la vas a pegar dos veces (pasos 4 y 6). No tiene que ser nada especial, solo difícil de adivinar.

**3.** Entra con tu cuenta. Se abrirá el navegador para que autorices:

```bash
cd worker && npx wrangler login
```

**4.** Sube la contraseña del paso 2 al Worker. Te la pedirá por pantalla:

```bash
cd worker && npx wrangler secret put PROXY_SIGNING_KEY
```

**5.** Despliega. Al terminar imprime una línea con la URL del Worker, parecida a
`https://api-pelis-proxy.algo.workers.dev`. **Cópiala**:

```bash
cd worker && npx wrangler deploy
```

**6.** Dale esos dos datos a la API. Primero la **URL del paso 5**:

```bash
npx vercel env add VIDEO_PROXY_URL production
```

Y ahora la **contraseña del paso 2** (la misma, exactamente igual):

```bash
npx vercel env add VIDEO_PROXY_KEY production
```

**7.** Redespliega para que la API las recoja:

```bash
npx vercel --prod
```

✅ Tarea 2 lista.

---

## Comprobar que funcionó

Pega esto:

```bash
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "https://api-catalogo-latino.vercel.app/api/v1/stream/direct?e=aHR0cHM6Ly92aWRoaWRlcGx1cy5jb20vdi81d3dmMnplcm50cGY"
```

**Lo único que importa es la dirección de la derecha.** Si acaba en `workers.dev`, funcionó: ese
vídeo ya no pasa por Vercel.

- Antes de la tarea 2: sale `200` y ninguna dirección (lo sirve Vercel).
- Después: sale `302` y una dirección `…workers.dev/?e=…`.

Si en vez de eso ves `502`, prueba con otra película: significa que ese vídeo concreto ya no
existe en el host, no que algo esté mal montado.

**Pásame la URL del Worker y lo verifico yo de punta a punta**, que es lo que de verdad demuestra
que reproduce.

---

## Por qué esto basta (y por qué no hace falta pagar nada)

De 28 744 reproducciones posibles del catálogo:

| se sirve como | reproducciones | coste |
| --- | --- | --- |
| `redirect` | 19 961 (75,6 %) | **0 bytes** |
| `manifest` | 5 661 (21,4 %) | ~200 KB |
| `proxy` | 797 (3,0 %) | ~3,2 GB → **pasa a Cloudflare** |

El 97 % ya no gastaba nada. El 3 % que sí gastaba es justo lo que se va al Worker, y Cloudflare no
cobra el tráfico de salida. Con cientos de usuarios al mes te sobra de largo.

**Si algún día el Worker fallara**, no te quedas sin nada ni tienes que pagar: la API responde 502
y el cliente reproduce con `embed_url`, que sirve el propio host y también es gratis. Ese respaldo
ya está implementado y probado.

---

## Lo único que queda por confirmar

El Worker acuña el vídeo y lo descarga en la misma invocación, que es lo que permite servir los
hosts que atan la URL a una IP (el 99 % del 3 % caro).

Si Cloudflare saliera por otra IP entre una petición y la siguiente, el CDN respondería 403 — y el
Worker ya lo contempla: vuelve a acuñar por su cuenta y sigue. El coste sería alguna petición
extra, no un fallo. Aun así **no lo doy por bueno hasta verlo desplegado**, que es justo lo que
esta semana ya me falló dos veces por confiarme.


---

## La región de la función, y por qué es `gru1`

`vercel.json` no admite comentarios, así que el porqué vive aquí.

**La función corría en Washington y su base de datos está en São Paulo.** Se ve en la cabecera de
cualquier respuesta:

```bash
curl -sD - -o /dev/null "https://api-catalogo-latino.vercel.app/api/v1/media/md-278/streams" | grep -i x-vercel-id
```

Salía `x-vercel-id: gru1::iad1::…` — la petición entra por São Paulo (`gru1`) y **la función se
ejecuta en Washington (`iad1`)**, que es el valor por defecto cuando no se dice nada.

Y la base no está allí. El host de la API va detrás de Cloudflare y no dice nada, pero el de la
base de datos no:

```bash
python -c "import socket;print(socket.getaddrinfo('db.kgeytmocuitbchpdcoad.supabase.co',5432))"
```

Resuelve a una IP de AWS localizada en **São Paulo**. (El control, `aws-0-us-east-1.pooler.supabase.com`,
sale en Virginia, así que el método distingue.)

O sea que cada consulta al catálogo cruzaba Washington ↔ São Paulo, y `catalogService` hace varias
por respuesta. **Y aquí importa más que en casi cualquier otra API**, porque la caché de borde de
las fichas está deliberadamente en 60 s —ver el comentario largo en `api/index.ts`, que lo bajó dos
veces por fallos reportados de contenido rancio—. Con una ventana tan corta, casi cada apertura de
ficha llega al origen: lo que el borde no absorbe lo paga la región.

Medido antes del cambio: 0,33 s por ficha, que es justo el número que el propio comentario de
`api/index.ts` da como coste de «leer la base».

### Lo que queda pendiente y NO se hizo

`vercel.json` sigue usando el `builds` heredado, y **`functions` no se puede usar junto a `builds`**
(está documentado por Vercel). Mientras siga así no hay forma de fijar `maxDuration` ni `memory`
por función. Migrar a `functions` + `rewrites` lo desbloquea, pero **cambia el enrutado de `/docs`
y `/panel`**, así que es un cambio que hay que desplegar y comprobar aparte. No se ha hecho aquí
porque no hay ninguna prueba de que los topes actuales estén estorbando: el acuñado tarda 2,3 s en
frío y 0,42 s en caliente, muy por debajo de cualquier límite.

### Comprobación después de desplegar

```bash
curl -sD - -o /dev/null "https://api-catalogo-latino.vercel.app/api/v1/media/md-278/streams" | grep -i x-vercel-id
```

Tiene que decir `gru1::gru1::` (o el PoP de entrada que toque, seguido de `gru1`), y el tiempo
total de la petición bajar de los 0,33 s de antes.


---

## El presupuesto de R2, y la regla que lo mantiene dentro

El plan gratuito de R2 son **10 GB**, y el Worker **no desaloja nada por su cuenta**: escribe trozos
y ahí se quedan. Sin una regla de caducidad, el bucket crece hasta pasarse.

Y hay algo que conviene no perder: los trozos del **índice** de cada película —los tres primeros y
los cuatro últimos— son los que hacen que ninguna arranque en frío. Solo los 240 títulos de
archive.org son ~6,7 GB de índices.

La regla:

```bash
npx wrangler r2 bucket lifecycle add api-pelis-cache --prefix v2/ --expire-days 7
```

Siete días para todo, **y los índices se reponen solos**: `calentarIndices` corre al final de cada
barrido del catálogo (cada 24 h) y es idempotente, así que un índice que caduque vuelve a estar
dentro del día siguiente. Lo que no vuelve es el cuerpo de una película que nadie ha visto en una
semana, que es exactamente lo que sobra.

> **Se simplificó a propósito.** La idea inicial era separar índices y cuerpo con prefijos
> distintos para conservar los primeros para siempre. No hace falta: con el barrido reponiéndolos
> cada día, una caducidad uniforme consigue lo mismo sin tocar `llaveDe` — y no tocar la función
> que calcula las claves de la caché es, en este proyecto, una virtud (ver el fallo de `e:43200`).

Para ver lo que ocupa en cualquier momento:

```bash
npx wrangler r2 bucket info api-pelis-cache
```
