import { CloudStore } from './cloudStore';

export interface SourceConfig {
  id: string; // 'tioplus' | 'fuegocine' | 'supabase'
  name: string;
  enabled: boolean;
  priority: number;
}

const DEFAULT_SOURCES: SourceConfig[] = [
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 1 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 2 },
  { id: 'supabase', name: 'Base de Datos Supabase', enabled: true, priority: 3 }
];

let currentSources: SourceConfig[] = [...DEFAULT_SOURCES];

export class SourceManager {
  /**
   * Obtiene las fuentes ordenadas por prioridad de forma asíncrona (sincronizando con la nube)
   */
  static async getSourcesAsync(): Promise<SourceConfig[]> {
    try {
      const cloudSources = await CloudStore.getSources();
      if (Array.isArray(cloudSources) && cloudSources.length > 0) {
        currentSources = cloudSources;
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
