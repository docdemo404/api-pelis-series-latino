"""
═══════════════════════════════════════════════════════════════════════════════════════════
ESCUCHAR UN FICHERO Y ESCRIBIR LO QUE SE DICE

Va en Python porque `faster-whisper` lo está: es la misma red de Whisper compilada con
CTranslate2, que en un procesador normal —que es todo lo que tiene un runner— va varias veces
más rápido que la implementación original y ocupa la mitad de memoria. El resto del repositorio
es TypeScript; esto es la excepción y tiene motivo.

── LO QUE HACE QUE EL TEXTO SEA FIEL Y NO «PARECIDO» ──────────────────────────────────────

Cuatro ajustes, y ninguno es cosmético:

  · `condition_on_previous_text=False`. Encendido —que es como viene— el modelo usa lo ya
    transcrito como contexto, y en cuanto se equivoca una vez se engancha: repite la misma frase
    veinte veces sobre una escena muda. Es el fallo más conocido de Whisper y así se corta.

  · Detección de voz antes de transcribir. Sobre música o silencio el modelo INVENTA —suele soltar
    la frase con la que se entrenó, del tipo «subtítulos por la comunidad»— porque su trabajo es
    escribir algo. Si no se le da silencio que rellenar, no lo rellena.

  · Marcas por palabra. Cada línea entra y sale con la primera y la última palabra que contiene,
    no con lo que estime el modelo para el bloque entero. Es la diferencia entre un subtítulo que
    va con la boca y uno que va medio segundo por detrás toda la película.

  · El reparto de la ficha como contexto inicial. Whisper acepta un texto de arranque y lo usa
    para decidir cómo se escribe lo que oye. Dándole los nombres de los personajes deja de
    escribirlos de oído — que es donde más canta una transcripción automática.

── DOS MODOS ─────────────────────────────────────────────────────────────────────────────

  ventanas → tres trozos de un minuto, para COMPROBAR si un subtítulo bajado es de esta copia.
  completo → la película entera, para escribir el subtítulo definitivo.

Uso:
    python transcribir.py --audio a.wav --modo completo [--idioma en] [--contexto "..."]

Escribe JSON por la salida estándar. Todo lo que sea información va a la de error, para que la
otra se pueda leer sin filtrar nada.
═══════════════════════════════════════════════════════════════════════════════════════════
"""
import argparse
import json
import os
import sys
import time


def avisar(texto: str) -> None:
    """Lo que se cuenta por el camino va a stderr: stdout es solo el JSON."""
    print(texto, file=sys.stderr, flush=True)


def lineas_legibles(palabras, corte_por_silencio=0.7, ancho=84):
    """
    Agrupa palabras sueltas en líneas que se puedan LEER.

    Whisper devuelve sus propios bloques y a veces son de veinte segundos: una parrafada que no
    cabe en pantalla y que aparece entera antes de que se diga la mitad. Aquí se corta por donde
    corta quien habla —un silencio de siete décimas— y por lo que cabe en dos renglones.

    El ancho es de dos líneas de 42 caracteres, que es lo que caben en un móvil tumbado sin
    taparle media cara a nadie.
    """
    lineas = []
    actual = []

    def cerrar():
        if not actual:
            return
        lineas.append({
            "inicio": actual[0].start,
            "fin": actual[-1].end,
            "texto": "".join(p.word for p in actual).strip(),
        })
        actual.clear()

    for palabra in palabras:
        if actual:
            silencio = palabra.start - actual[-1].end
            largo = sum(len(p.word) for p in actual)
            if silencio >= corte_por_silencio or largo >= ancho:
                cerrar()
        actual.append(palabra)

    cerrar()
    return lineas


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True)
    p.add_argument("--modo", choices=["ventanas", "completo"], default="completo")
    # El desplazamiento real de este audio dentro de la película, para el modo ventanas: el
    # fichero empieza en cero pero lo que contiene son los minutos 15, 50 y 80.
    p.add_argument("--desde", type=float, default=0.0)
    p.add_argument("--idioma", default=None)
    p.add_argument("--contexto", default=None)
    args = p.parse_args()

    from faster_whisper import WhisperModel

    # El modelo se elige por entorno para poder bajar de categoría sin tocar código cuando lo que
    # sobra es prisa y no calidad. Por defecto el grande: lo que se pidió es fidelidad.
    nombre = os.environ.get("WHISPER_MODELO", "large-v3")
    hilos = int(os.environ.get("WHISPER_HILOS", "0")) or os.cpu_count() or 4

    t0 = time.time()
    avisar(f"🧠 cargando {nombre} · {hilos} hilos")
    modelo = WhisperModel(nombre, device="cpu", compute_type="int8", cpu_threads=hilos)
    avisar(f"   listo en {time.time() - t0:.0f} s")

    t1 = time.time()
    segmentos, info = modelo.transcribe(
        args.audio,
        language=args.idioma,
        task="transcribe",
        beam_size=5,
        word_timestamps=True,
        # Ver la cabecera: sin esto, un tropiezo se convierte en un bucle.
        condition_on_previous_text=False,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        initial_prompt=args.contexto,
    )

    palabras = []
    ultimo_aviso = 0.0
    for segmento in segmentos:
        for palabra in (segmento.words or []):
            palabras.append(palabra)
        # `transcribe` devuelve un generador: el trabajo ocurre AQUÍ, al recorrerlo.
        if segmento.end - ultimo_aviso >= 300:
            ultimo_aviso = segmento.end
            avisar(f"   … min {segmento.end / 60:.0f} en {(time.time() - t1) / 60:.1f} min de reloj")

    lineas = lineas_legibles(palabras)
    if args.desde:
        for l in lineas:
            l["inicio"] += args.desde
            l["fin"] += args.desde

    tardo = time.time() - t1
    avisar(
        f"✅ {len(lineas)} líneas · idioma {info.language} ({info.language_probability:.0%}) · "
        f"{info.duration / 60:.0f} min de audio en {tardo / 60:.1f} min "
        f"({(info.duration / tardo if tardo else 0):.1f}× tiempo real)"
    )

    json.dump({
        "idioma": info.language,
        "seguridad": round(info.language_probability, 3),
        "segundos_audio": round(info.duration),
        "segundos_maquina": round(tardo),
        "modelo": nombre,
        "lineas": lineas,
    }, sys.stdout, ensure_ascii=False)

    return 0


if __name__ == "__main__":
    sys.exit(main())
