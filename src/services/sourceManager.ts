import fs from 'fs';
import path from 'path';

export interface SourceConfig {
  id: string; // 'tioplus' | 'fuegocine' | 'supabase'
  name: string;
  enabled: boolean;
  priority: number;
}

const SOURCES_FILE = path.join(__dirname, '../data/sources.json');

const DEFAULT_SOURCES: SourceConfig[] = [
  { id: 'tioplus', name: 'TioPlus / PelisPlus Latino', enabled: true, priority: 1 },
  { id: 'fuegocine', name: 'FuegoCine', enabled: true, priority: 2 },
  { id: 'supabase', name: 'Base de Datos Supabase', enabled: true, priority: 3 }
];

let currentSources: SourceConfig[] = loadSources();

function loadSources(): SourceConfig[] {
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const content = fs.readFileSync(SOURCES_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.sort((a: any, b: any) => a.priority - b.priority);
      }
    }
  } catch (err) {
    console.warn('[SourceManager] Error leyendo sources.json:', err);
  }
  return DEFAULT_SOURCES;
}

function saveSources(sources: SourceConfig[]) {
  try {
    const dir = path.dirname(SOURCES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2), 'utf8');
  } catch (err) {
    console.warn('[SourceManager] Error guardando sources.json:', err);
  }
}

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

    saveSources(currentSources);
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
