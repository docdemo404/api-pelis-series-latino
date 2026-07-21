import axios from 'axios';
import { CatalogService } from './catalogService';
import { ServerOption } from '../types';

export class CheckerService {
  /**
   * Inspecciona la salud de un enlace de servidor
   */
  static async checkLinkHealth(server: ServerOption): Promise<'online' | 'offline'> {
    try {
      const response = await axios.get(server.embed_url, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        validateStatus: () => true
      });

      if (response.status >= 400) {
        return 'offline';
      }

      const html = typeof response.data === 'string' ? response.data.toLowerCase() : '';

      const deadSignatures = [
        'file removed',
        'file deleted',
        'video not found',
        'archivo no encontrado',
        'content deleted',
        '404 not found'
      ];

      const isDead = deadSignatures.some(sig => html.includes(sig));
      return isDead ? 'offline' : 'online';
    } catch (error) {
      return 'offline';
    }
  }

  /**
   * Escanea y actualiza la salud del catálogo (scrapea en vivo de TioPlus)
   */
  static async runFullHealthCheck() {
    console.log(`[HealthChecker] 🔄 Iniciando verificación automática de enlaces: ${new Date().toISOString()}`);
    const items = await CatalogService.getAll();
    let checkedCount = 0;
    let onlineCount = 0;
    let offlineCount = 0;

    for (const item of items) {
      const servers = item.servers || [];
      for (const server of servers) {
        checkedCount++;
        const status = await this.checkLinkHealth(server);
        server.status = status;
        server.last_checked = new Date().toISOString();

        if (status === 'online') onlineCount++;
        else offlineCount++;
      }
    }

    console.log(`[HealthChecker] ✅ Verificación completada. Procesados: ${checkedCount} | Activos: ${onlineCount} | Caídos: ${offlineCount}`);
  }
}

// Permitir ejecución directa por CLI / Cron
if (require.main === module) {
  CheckerService.runFullHealthCheck().then(() => {
    process.exit(0);
  });
}
