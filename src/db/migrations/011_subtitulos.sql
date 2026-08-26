-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- SUBTÍTULOS PROPIOS, PARA LO QUE NO TRAE NINGUNO
--
-- Buena parte del catálogo llega sin una sola pista de texto: el reproductor abre el menú de
-- «Audio y subtítulos» y la columna de la derecha solo tiene «Desactivados». Esto es donde se
-- guardan los que se generan nosotros mismos escuchando la película.
--
-- ── POR QUÉ TRANSCRIBIENDO Y NO BAJANDO UN .SRT DE POR AHÍ ─────────────────────────────────
--
-- Un fichero de subtítulos de un banco público está hecho para UN montaje concreto. Si el que
-- tenemos no es exactamente ese —y casi nunca lo es: estos hosts republican versiones con
-- distintos cortes, logos delante y anuncios metidos— el texto va corrido varios segundos
-- respecto a las bocas. Eso es peor que no tener nada, porque se lee algo que no se está
-- diciendo, y arreglarlo a mano es imposible a escala de catálogo.
--
-- Transcribiendo el audio DE ESTE fichero, el tiempo de cada línea sale del propio audio. No hay
-- nada que sincronizar porque nunca estuvo desincronizado.
--
-- ── Y AUN ASÍ SE BAJAN LOS PÚBLICOS, PORQUE ESCUCHAR CUESTA HORAS ─────────────────────────
--
-- Lo de arriba es el motivo de no FIARSE de un fichero público, no el de no usarlo. Transcribir
-- una película entera son decenas de minutos de máquina y el runner gratis da para unas pocas al
-- día; un fichero hecho por una persona está en segundos y además se lee mejor que cualquier
-- transcripción automática.
--
-- La salida es comprobarlo en vez de creerlo: se transcriben TRES VENTANAS de un minuto y se
-- buscan esas palabras en el fichero. Si están y a su hora, encaja con esta copia y se publica. Si
-- están pero corridas siempre lo mismo, se corrige el desfase. Si no están, es de otra versión y
-- se tira. Un minuto de máquina para decidirlo, contra las horas que cuesta la película entera.
--
-- Y hay una consecuencia que importa más que el ahorro: un público comprobado **cierra el
-- trabajo**, de modo que las horas del runner se van enteras a los títulos que no tienen nada.
--
-- CON UNA EXCEPCIÓN, Y ES LA QUE MÁS SE VA A NOTAR: EL INGLÉS.
--
-- Un subtítulo escrito por una persona está CONDENSADO. Resume las frases largas para que quepan
-- y se lean, se salta muletillas y repeticiones, y los de sordos meten acotaciones que nadie dice.
-- Para acompañar un doblaje eso está bien; para seguir el audio original palabra por palabra, no
-- es lo mismo que suena.
--
-- Y eso es exactamente lo que se pidió del inglés: que sea lo que se habla. Así que ahí el fichero
-- público es SOLO el parche mientras la transcripción llega, y cuando llega, lo sustituye. En
-- español, donde el público bien sincronizado cumple de sobra, se queda.
--
-- ── LOS DOS IDIOMAS NO SALEN IGUAL, Y CONVIENE SABERLO ─────────────────────────────────────
--
--   · El idioma QUE SE HABLA se transcribe. Es lo más fiel que se puede tener: son las palabras
--     que suenan, con sus tiempos.
--   · El OTRO se traduce de la transcripción. Es fiel al significado, no a la letra.
--
-- Por eso cada fila dice de dónde viene (`origen`). No es metadato de adorno: es la diferencia
-- entre «esto es lo que dicen» y «esto es lo que quiere decir», y quien lo lee tiene derecho a
-- saber cuál de las dos está leyendo.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subtitulos (
    id BIGSERIAL PRIMARY KEY,

    media_id VARCHAR(255) NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,

    -- CADENA VACÍA EN LAS PELÍCULAS, NO NULL. En Postgres dos NULL no son iguales, así que con
    -- `NULL` la clave única de abajo dejaría entrar la misma película cien veces.
    episodio_id VARCHAR(255) NOT NULL DEFAULT '',

    -- 'es' | 'en'. Sin región: el reproductor enseña la etiqueta, no el código.
    idioma VARCHAR(10) NOT NULL,

    -- Lo que se lee en el menú: «Español (generado)».
    etiqueta VARCHAR(80) NOT NULL,

    -- De dónde salió este texto. Son tres cosas distintas y el menú tiene derecho a decirlo:
    --
    --   'transcrito' → se escuchó ESTE audio. Las palabras que suenan, con sus tiempos.
    --   'traducido'  → se tradujo la transcripción del otro idioma. Fiel al sentido, no a la letra.
    --   'publico'    → un fichero hecho por una persona, bajado de un banco público Y COMPROBADO
    --                  contra el audio de esta copia (ver `desfase_ms`). Sin esa comprobación no
    --                  entra: un subtítulo de otro montaje va corrido y se lee lo que no se dice.
    origen VARCHAR(20) NOT NULL CHECK (origen IN ('transcrito', 'traducido', 'publico')),

    /*
     * EL DESFASE QUE HUBO QUE CORREGIRLE, EN MILISEGUNDOS.
     *
     * Solo tiene sentido en los públicos. El sondeo transcribe tres ventanas de un minuto de la
     * película —al 15 %, al 50 % y al 80 %— y busca esas mismas palabras en el fichero. Si están
     * pero siempre corridas lo mismo, no es un fichero equivocado: es el mismo montaje con otro
     * arranque, y se arregla sumándole este número a cada marca de tiempo.
     *
     * Se guarda aunque ya venga aplicado al contenido, porque es la prueba de que la comprobación
     * se hizo y de cuánto bailaba. Cero significa que encajaba tal cual.
     */
    desfase_ms INT,

    /*
     * Cuánto se pareció lo que dice el fichero a lo que de verdad suena, de 0 a 1.
     *
     * Es lo que decide si se publica o se tira, y queda escrito para poder subir el listón después
     * sin volver a bajar nada: con el número guardado, revisar el criterio es una consulta.
     */
    parecido NUMERIC(4, 3),

    -- El WebVTT entero. Una película son 40-90 KB de texto; no compensa un fichero aparte ni un
    -- bucket con su propio ciclo de vida cuando cabe en la fila que ya se está leyendo.
    contenido TEXT NOT NULL,

    -- Con qué se hizo, para poder rehacer lo viejo cuando haya algo mejor sin tocar lo demás.
    modelo VARCHAR(60),

    -- Cuánto audio se escuchó. Sirve para detectar el fallo silencioso: una transcripción de 4
    -- minutos para una película de 100 es un fichero que se cortó, no una película muda.
    segundos_audio INT,

    creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT subtitulos_unicos UNIQUE (media_id, episodio_id, idioma)
);

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CON RLS, Y AQUÍ NO ES BUROCRACIA
 *
 * El resto del esquema va con RLS desactivado, pero estas dos tablas no pueden permitírselo, y el
 * motivo es concreto: **el anon key está escrito en el código** (`src/services/supabaseService.ts`)
 * y este repositorio es público. O sea que ese key lo tiene cualquiera que sepa leer GitHub.
 *
 * Con RLS apagado, ese key da ESCRITURA sobre lo que toque. En estas dos tablas eso significa:
 *
 *   · meter texto arbitrario en `subtitulos`, que la app pinta encima del vídeo;
 *   · inundar `subtitulos_cola` y gastar los minutos de GitHub Actions transcribiendo basura.
 *
 * No cuesta nada cerrarlo: todo lo que escribe aquí —la API y los barridos— usa
 * `getSupabaseAdmin()`, que va con la *service role*, y esa se salta RLS por diseño.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
ALTER TABLE subtitulos ENABLE ROW LEVEL SECURITY;

/*
 * LEER SÍ, ESCRIBIR NO.
 *
 * El texto de un subtítulo no es un secreto: se sirve a cualquiera que reproduzca la película, y
 * la ruta que lo entrega no pide nada. Dejar la lectura abierta es además la red de seguridad de
 * un caso concreto: si el entorno que sirve la API se quedara sin `SUPABASE_SERVICE_ROLE_KEY`,
 * `getSupabaseAdmin()` degrada al cliente anon —lo dice su propio comentario— y sin esta política
 * los subtítulos dejarían de servirse sin que nada lo dijera.
 *
 * Lo que NO hay es política de escritura, y esa ausencia es la que cierra la puerta.
 */
CREATE POLICY subtitulos_lectura_publica ON subtitulos
    FOR SELECT USING (true);

-- El acceso real es siempre «dame los de esta ficha», y en series «los de este capítulo».
CREATE INDEX IF NOT EXISTS idx_subtitulos_ficha ON subtitulos (media_id, episodio_id);


-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- LA COLA: QUÉ SE TRANSCRIBE ANTES
--
-- Escuchar una película entera cuesta entre veinte minutos y una hora de máquina. Con un catálogo
-- de miles, ir en orden de base de datos significa que lo que alguien quiere ver esta noche le
-- toca dentro de año y medio.
--
-- Así que manda LA DEMANDA: cuando alguien abre algo sin subtítulos, esa ficha entra aquí y es la
-- siguiente. Lo que nadie pide se transcribe con lo que sobre, y si no sobra nada tampoco se
-- pierde: sigue en la cola.
--
-- `intentos` y `ultimo_error` existen porque estos ficheros se caen. Un título que falla tres
-- veces deja de intentarse para no gastarse la ventana entera en el mismo imposible.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subtitulos_cola (
    id BIGSERIAL PRIMARY KEY,

    media_id VARCHAR(255) NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episodio_id VARCHAR(255) NOT NULL DEFAULT '',

    -- Cuanto más alta, antes. Lo que pide un espectador entra con prioridad; el relleno, con 0.
    prioridad INT NOT NULL DEFAULT 0,

    intentos INT NOT NULL DEFAULT 0,
    ultimo_error TEXT,

    pedido_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    -- Cuándo se terminó. Mientras sea NULL, sigue pendiente.
    hecho_en TIMESTAMP WITH TIME ZONE,

    CONSTRAINT subtitulos_cola_unica UNIQUE (media_id, episodio_id)
);

/*
 * LA COLA VA CERRADA DEL TODO: ni lectura ni escritura para nadie que no sea la service role.
 *
 * Aquí no hay nada que un cliente necesite ver —la app pregunta por las pistas, no por la cola— y
 * en cambio sí hay algo que perder: quien pueda escribir aquí decide en qué gasta el runner las
 * próximas seis horas.
 */
ALTER TABLE subtitulos_cola ENABLE ROW LEVEL SECURITY;

-- El barrido pregunta siempre lo mismo: lo pendiente, lo más pedido primero.
CREATE INDEX IF NOT EXISTS idx_subtitulos_cola_pendiente
    ON subtitulos_cola (prioridad DESC, pedido_en ASC)
    WHERE hecho_en IS NULL;
