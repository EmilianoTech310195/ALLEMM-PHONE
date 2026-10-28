<?php
/* ============================================================
   ALLEMM — Configuración del monitoreo (PLANTILLA)
   ------------------------------------------------------------
   1. Copia este archivo como  db_config.php  (en esta misma carpeta).
   2. Llena los datos de la base MySQL de ALLEMM y los dos tokens.
   3. db_config.php NUNCA se sube a GitHub (está en .gitignore).
   ============================================================ */

// Base de datos MySQL / MariaDB de ALLEMM (SiteGround → MySQL → Databases)
define('DB_HOST', 'localhost');
define('DB_NAME', 'base_de_allemm');
define('DB_USER', 'usuario_de_allemm');
define('DB_PASS', 'contraseña_de_allemm');

// Token que mandan los teléfonos al reportar (va también en js/allemm-config.js → monitorToken).
// Solo sirve para REPORTAR: con él no se puede leer nada.
define('REPORT_TOKEN', 'cambia-este-token-de-reporte');

// Token del panel de administración: permite LEER reportes y editar agentes/metas.
// No lo compartas con los agentes. Se escribe una vez en el panel (admin/).
define('ADMIN_TOKEN', 'cambia-este-token-de-admin');

// Zona horaria y corte semanal del panel (no borra nada: solo define "esta semana").
define('TZ_LOCAL', 'America/Mexico_City');
define('WEEK_CUT_DOW', 7);     // 1 = lunes … 7 = domingo
define('WEEK_CUT_HOUR', 20);   // 20 = 8:00 PM
