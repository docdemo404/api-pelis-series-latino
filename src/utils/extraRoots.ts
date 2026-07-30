/**
 * Eslabón de certificación que los almacenes de confianza todavía no traen.
 *
 * `ahvsh.com` y `streamlare.com` (199 servidores) llevaban sin poder ni MIRARSE: toda petición
 * moría con `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` antes de leer un byte, así que ni se extraía su
 * vídeo ni se sabía si estaban vivos — en la clasificación por hosts salían como "no se alcanza",
 * que es la peor casilla porque no dice nada.
 *
 * No era culpa de esos hosts. Su certificado cuelga de `Let's Encrypt YE1` → `ISRG Root YE`, una
 * raíz nueva (sep-2025) que Let's Encrypt AVISA en su propia página que aún no está en ningún
 * almacén importante, y el que Node lleva compilado dentro es uno de ellos.
 *
 * LO QUE SE AÑADE AQUÍ NO ES CONFIANZA NUEVA, y por eso es aceptable: es Root YE **firmada de
 * forma cruzada por ISRG Root X2**, que sí es una raíz que Node ya trae de fábrica. Con este
 * eslabón la cadena vuelve a terminar donde terminaba siempre. La validación no se relaja en
 * ningún punto: `rejectUnauthorized` sigue activo y un certificado inválido sigue fallando.
 *
 * Va como constante y no como fichero .pem a propósito: el empaquetado de Vercel solo arrastra
 * JavaScript, así que un fichero suelto al lado del código existiría en local y no en producción
 * — el peor de los fallos, el que solo aparece desplegado.
 *
 * Origen: https://letsencrypt.org/certs/gen-y/root-ye-by-x2.pem
 * Sujeto: C=US, O=ISRG, CN=Root YE · Emisor: CN=ISRG Root X2 · válido 2026-05-13 → 2032-09-02
 */
export const ISRG_ROOT_YE_BY_X2 = `-----BEGIN CERTIFICATE-----
MIICpjCCAiugAwIBAgIRAIchZfw0tuX7qK3Vs3BftTowCgYIKoZIzj0EAwMwTzEL
MAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2VhcmNo
IEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDIwHhcNMjYwNTEzMDAwMDAwWhcN
MzIwOTAyMjM1OTU5WjAuMQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4G
A1UEAxMHUm9vdCBZRTB2MBAGByqGSM49AgEGBSuBBAAiA2IABDwS/6vhrcVqcbBo
+wgdI3fwn9x7DNJJOY/lTOti0vkwuRN87RhEhTH17E7XyFjWsPYhIPt/wzOqxTd2
b+4ZJNy9ID04YywF9U5zasDVyGSNErVNtz8uSGh5izW87j77GaOB6zCB6DAOBgNV
HQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDwYDVR0TAQH/BAUwAwEB
/zAdBgNVHQ4EFgQUo8gmWo6hTNA1Y/ybI8g6rlbzT1YwHwYDVR0jBBgwFoAUfEKW
rt5LSDv6kviejM9ti6lyN5UwMgYIKwYBBQUHAQEEJjAkMCIGCCsGAQUFBzAChhZo
dHRwOi8veDIuaS5sZW5jci5vcmcvMBMGA1UdIAQMMAowCAYGZ4EMAQIBMCcGA1Ud
HwQgMB4wHKAaoBiGFmh0dHA6Ly94Mi5jLmxlbmNyLm9yZy8wCgYIKoZIzj0EAwMD
aQAwZgIxAMU19WCtmxVND8UHBZRoma49Z7jPs64Dma0eTu1OChVbB/2J7GV3nvYK
Ax54uk1G9QIxAO0miLVJu8PLNiXXXkiE/gsK3CTRTF/aeo4bMX42Zw40csRU6AC2
6hSW1/IWaas6dg==
-----END CERTIFICATE-----`;
