export interface SourceConfig {
  id: string; // 'tioplus' | 'fuegocine' | 'supabase'
  name: string;
  enabled: boolean;
  priority: number;
}

let currentSources: SourceConfig[] = [
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 1 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 2 },
  { id: 'supabase', name: 'Base de Datos Supabase', enabled: true, priority: 3 }
];

export class SourceManager {
  /**
   * Obtiene las fuentes ordenadas por prioridad
   */
  static getSources(): SourceConfig[] {
    return [...currentSources].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Actualiza el estado y prioridad de las fuentes
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

    return this.getSources();
  }

  /**
   * Verifica si una fuente está activa
   */
  static isEnabled(sourceId: string): boolean {
    const s = currentSources.find(x => x.id === sourceId);
    return s ? s.enabled : true;
  }
}
