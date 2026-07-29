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
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "https://api-pelis-series-latino.vercel.app/api/v1/stream/direct?e=aHR0cHM6Ly92aWRoaWRlcGx1cy5jb20vdi81d3dmMnplcm50cGY"
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
