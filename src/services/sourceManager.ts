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
let isInitialized = false;

// Inicializar sincronización remota en segundo plano
CloudStore.getSources().then(sources => {
  if (sources && sources.length > 0) {
    currentSources = sources;
    isInitialized = true;
  }
}).catch(() => {});

export class SourceManager {
  /**
   * Obtiene las fuentes ordenadas por prioridad
   */
  static getSources(): SourceConfig[] {
    // Disparar sincronización silenciosa si no se ha inicializado
    if (!isInitialized) {
      CloudStore.getSources().then(s => {
        if (s && s.length > 0) currentSources = s;
      }).catch(() => {});
    }
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

    // Guardar en la nube y disco local
    CloudStore.saveSources(currentSources).catch(err => {
      console.warn('[SourceManager] Cloud save error:', err);
    });

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
