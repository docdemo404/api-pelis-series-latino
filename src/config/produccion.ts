/**
 * LA DIRECCIÓN DE LA API EN PRODUCCIÓN, escrita UNA vez.
 *
 * El 2026-08-28 el despliegue se mudó a `api-catalogo-latino.vercel.app` y los dos viejos se
 * borraron (ver README, «UN SOLO DESPLIEGUE»). Cinco scripts se quedaron con el viejo
 * `…-gilt.vercel.app` como valor por defecto, y ese dominio contesta hoy `404 The deployment could
 * not be found` a TODO.
 *
 * Lo que eso hizo, medido en el log de `verificar.yml` del 2026-09-17 a las 21:02:
 *
 *   NO  (ilegible)      404/85B | 404/85B | 404/85B | 404/85B
 *   NO  archive.org     404/85B | ...
 *   NO  videoapi.la     404/85B | ...
 *   ❌ 10 host(s) que la API NO puede entregar   ·   🚫 538 sellos retirados · 524 dejan de anunciarse
 *
 * `--entrega` le preguntaba a un dominio muerto si podía servir cada host, tomaba el 404 por
 * «este host no entrega» —que es lo que un 404 significa cuando lo da la API viva— y condenaba a
 * los diez hosts del catálogo en cada vuelta, cuatro veces al día. Los hosts normales sobrevivían
 * porque `--verificar` los vuelve a sellar a las pocas horas; los de NetMirror no tienen quien los
 * reselle y se quedaron fuera: 1.906 de 2.424.
 *
 * Por eso la dirección vive aquí y no repetida en cada script: cuando vuelva a cambiar, cambia
 * en un sitio. Y cada script sigue admitiendo su variable de entorno para apuntar a otro lado.
 */
export const API_PRODUCCION = 'https://api-catalogo-latino.vercel.app';

/** La dirección de la API: la primera variable de entorno que venga, o la de producción. */
export function urlApiProduccion(...variables: string[]): string {
  for (const v of variables) {
    const valor = (process.env[v] || '').trim();
    if (valor) return valor.replace(/\/+$/, '');
  }
  return API_PRODUCCION;
}
