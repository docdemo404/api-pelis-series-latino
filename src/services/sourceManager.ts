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
 * supabase— mientras `DEFAULT_SOURCES` ponía a **Cinecalidad la primera**, con su motivo escrito
 * al lado (de sus reproductores, `vimeos` y `goodstream` se extraen y entregan desde el
 * datacenter). El almacén se había guardado antes de que existiera, y ganaba siempre.
 *
 * Lo que costaba: `sortServersBySourcePriority` construye su mapa de prioridades con esta lista,
 * así que los servidores de Cinecalidad no tenían prioridad asignada y la decisión de ponerla
 * delante —tomada a propósito, midiendo— no llegó a aplicarse ni un solo día.
 *
 * Es el mismo patrón que ya ha mordido tres veces esta semana: un valor guardado tapando en
 * silencio a uno nuevo del código. Se arregla igual que los otros — el almacén decide sobre lo que
 * conoce (`enabled` y `priority`, que es lo que el panel edita) y lo que no conoce se conserva.
 */
function fusionarConLosPorDefecto(guardadas: SourceConfig[]): SourceConfig[] {
  const porId = new Map(guardadas.map(s => [s.id, s]));
  const fusionadas = DEFAULT_SOURCES.map(porDefecto => {
    const guardada = porId.get(porDefecto.id);
    porId.delete(porDefecto.id);
    return guardada
      ? { ...porDefecto, enabled: guardada.enabled, priority: guardada.priority }
      : { ...porDefecto };
  });
  // Y las que solo estén en el almacén (alguien las añadió por el panel) se conservan.
  return [...fusionadas, ...porId.values()];
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
