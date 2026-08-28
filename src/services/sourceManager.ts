import { CloudStore } from './cloudStore';
import { SourceConfig, DEFAULT_SOURCES } from '../config/sources';

// Re-export para compatibilidad con quienes importaban el tipo desde aquí.
export type { SourceConfig };

let currentSources: SourceConfig[] = [...DEFAULT_SOURCES];

/**
 * LO GUARDADO MANDA SOBRE LO QUE YA CONOCÍA, PERO NO BORRA LO NUEVO.
 *
 * Esto sustituía la lista entera por la del almacén (`currentSources = cloudSources`), y con eso
 * una fuente añadida al código DESPUÉS de la última vez que alguien tocó el panel no aparecía
 * nunca. No es teórico: el 2026-08-19 producción listaba tres fuentes —tioplus, fuegocine y
 * supabase— mientras `DEFAULT_SOURCES` ponía delante a una fuente añadida después, con su motivo
 * escrito al lado. El almacén se había guardado antes de que existiera, y ganaba siempre.
 *
 * Lo que costaba: `sortServersBySourcePriority` construye su mapa de prioridades con esta lista,
 * así que los servidores de la fuente nueva no tenían prioridad asignada y la decisión de ponerla
 * delante —tomada a propósito, midiendo— no llegó a aplicarse ni un solo día.
 *
 * Es el mismo patrón que ya ha mordido tres veces esta semana: un valor guardado tapando en
 * silencio a uno nuevo del código. Se arregla igual que los otros — el almacén decide sobre lo que
 * conoce (`enabled` y `priority`, que es lo que el panel edita) y lo que no conoce se conserva.
 */
function fusionarConLosPorDefecto(guardadas: SourceConfig[]): SourceConfig[] {
  const porId = new Map(guardadas.map(s => [s.id, s]));
  const fusionadas = DEFAULT_SOURCES.map((porDefecto, orden) => {
    const guardada = porId.get(porDefecto.id);
    porId.delete(porDefecto.id);
    return {
      fuente: guardada
        ? { ...porDefecto, enabled: guardada.enabled, priority: guardada.priority }
        : { ...porDefecto },
      orden,
    };
  });
  /**
   * LO QUE SOLO ESTÁ EN EL ALMACÉN SE DESCARTA, y esto es un cambio deliberado.
   *
   * Antes se conservaba «por si alguien la añadió desde el panel». Pero el panel NO sabe añadir
   * fuentes: `updateSourcesAsync` recorre las que ya hay y solo les cambia `enabled` y
   * `priority`. Así que una fuente que solo vive en el almacén no es algo que alguien creara —
   * es algo que se quitó del código y quedó fosilizado ahí.
   *
   * Pasó con `supabase`, que se retiró de `DEFAULT_SOURCES` por no ser una web que se scrapee
   * (es donde se guarda lo scrapeado) y siguió apareciendo en el panel como «Prioridad #4 ·
   * Fuente Activa», con su interruptor, porque la copia guardada sobrevivía a la fusión.
   *
   * El código manda sobre qué fuentes EXISTEN; el almacén, solo sobre cómo están configuradas.
   */
  const extras: Array<{ fuente: SourceConfig; orden: number }> = [];

  /**
   * Y SE RENUMERAN, para que no queden dos fuentes con la misma prioridad.
   *
   * Una fuente nueva llega con la prioridad que le puso el código y las guardadas con la suya, así
   * que se pisan: al añadir una fuente nueva, producción quedó con dos fuentes en `priority: 1` a la
   * vez. No rompe el orden de la lista —el desempate es el orden de `DEFAULT_SOURCES`— pero sí
   * empata el mapa de `sortServersBySourcePriority`, que es quien decide qué servidor intenta
   * primero el cliente. Un empate ahí deja la decisión al azar del resto de criterios.
   *
   * Renumerar 1..n conserva el orden RELATIVO que el usuario guardó desde el panel y solo mete a
   * la nueva en su sitio, que es exactamente lo que se quiere: nadie pierde su configuración y la
   * fuente añadida ocupa el lugar que el código pedía.
   */
  return [...fusionadas, ...extras]
    .sort((a, b) => (a.fuente.priority - b.fuente.priority) || (a.orden - b.orden))
    .map(({ fuente }, i) => ({ ...fuente, priority: i + 1 }));
}

export class SourceManager {
  /**
   * Obtiene las fuentes ordenadas por prioridad de forma asíncrona (sincronizando con la nube)
   */
  static async getSourcesAsync(): Promise<SourceConfig[]> {
    try {
      const cloudSources = await CloudStore.getSources();
      if (Array.isArray(cloudSources) && cloudSources.length > 0) {
        currentSources = fusionarConLosPorDefecto(cloudSources);
      }
    } catch (e) {}
    return [...currentSources].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Obtiene las fuentes ordenadas por prioridad (versión sincrónica con memoria)
   */
  static getSources(): SourceConfig[] {
    return [...currentSources].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Actualiza el estado y prioridad de las fuentes
   */
  static async updateSourcesAsync(newSources: Partial<SourceConfig>[]): Promise<SourceConfig[]> {
    currentSources = currentSources.map(existing => {
      const match = newSources.find(n => n.id === existing.id);
      if (match) {
        return {
          ...existing,
          enabled: typeof match.enabled === 'boolean' ? match.enabled : existing.enabled,
          priority: typeof match.priority === 'number' ? match.priority : existing.priority
        };
      }
      return existing;
    }).sort((a, b) => a.priority - b.priority);

    // Guardar asíncronamente en la nube
    await CloudStore.saveSources(currentSources);
    return this.getSources();
  }

  /**
   * Actualiza síncronamente en memoria
   */
  static updateSources(newSources: Partial<SourceConfig>[]): SourceConfig[] {
    currentSources = currentSources.map(existing => {
      const match = newSources.find(n => n.id === existing.id);
      if (match) {
        return {
          ...existing,
          enabled: typeof match.enabled === 'boolean' ? match.enabled : existing.enabled,
          priority: typeof match.priority === 'number' ? match.priority : existing.priority
        };
      }
      return existing;
    }).sort((a, b) => a.priority - b.priority);

    CloudStore.saveSources(currentSources).catch(() => {});
    return this.getSources();
  }

  /**
   * Verifica si una fuente está activa
   */
  static isEnabled(sourceId: string): boolean {
    const s = this.getSources().find(x => x.id === sourceId);
    return s ? s.enabled : true;
  }
}
