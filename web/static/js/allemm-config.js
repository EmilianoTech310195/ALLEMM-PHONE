/* ========================================
   ALLEMM SIP Web — Configuración del sitio
   ========================================
   ESTE es el archivo que se edita en el servidor para conectar la WebApp
   al conmutador (PBX) y al recolector de monitoreo de ALLEMM.
   No hace falta recompilar: se guarda y los teléfonos lo toman al abrir.

   ⚠️ Sin conmutador de ALLEMM todavía: sipServer queda vacío y el agente
   tendría que escribirlo en el inicio de sesión.
   ======================================== */
window.ALLEMM_WEB_CONFIG = {
    // Conmutador de ALLEMM (lo entrega el proveedor del PBX)
    sipServer: '',                 // ej. 'pbxXXXXX.pbxhosting.com.mx'
    wssPort: 8089,                 // puerto WSS (8089, o 443 si el proveedor lo ofrece)
    wssPath: '/ws',

    // Monitoreo: recolector de ESTE servidor y su token de reporte
    // (el mismo REPORT_TOKEN de monitor/db_config.php).
    monitorUrl: 'monitor/collector.php',
    monitorToken: ''
};
