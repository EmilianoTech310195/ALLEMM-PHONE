<?php
/* ============================================================
   ALLEMM — Instalador de la base de datos (un clic)
   ------------------------------------------------------------
   Abrir:  .../monitor/setup_db.php?token=<ADMIN_TOKEN>
   - Crea las tablas (agentes, llamadas, config) si no existen.
   - Carga/actualiza los agentes de directory.js (no borra nada).
   Se puede abrir las veces que sea: no duplica ni pierde datos.
   ============================================================ */

require_once __DIR__ . '/db.php';
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');

function page($title, $lines, $ok) {
    $color = $ok ? '#3fb37f' : '#e5534b';
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
       . '<title>ALLEMM · Instalar base de datos</title>'
       . '<body style="margin:0;background:#0A0A0C;color:#F3F1EC;font:15px/1.6 system-ui,Segoe UI,Arial,sans-serif">'
       . '<div style="max-width:640px;margin:40px auto;padding:24px;border:1px solid #26262d;border-radius:10px;background:#121216">'
       . '<div style="font:12px monospace;letter-spacing:.24em;color:#C69F5A">// ALLEMM · TELEFONÍA</div>'
       . '<h1 style="font-size:22px;margin:8px 0 16px;color:' . $color . '">' . htmlspecialchars($title) . '</h1><ul>';
    foreach ($lines as $l) echo '<li>' . htmlspecialchars($l) . '</li>';
    echo '</ul></div></body>';
    exit;
}

$admin = defined('ADMIN_TOKEN') ? ADMIN_TOKEN : (defined('MON_TOKEN') ? MON_TOKEN : '');
if ($admin === '') page('Falta configurar', ['Copia monitor/db_config.sample.php como db_config.php y llénalo.'], false);
if (!hash_equals($admin, (string)($_GET['token'] ?? ''))) {
    http_response_code(403);
    page('Token incorrecto', ['Abre esta página con ?token=<ADMIN_TOKEN> (el de db_config.php).'], false);
}

$pdo = db();
if (!$pdo) page('No conecta a MySQL', ['Revisa DB_HOST, DB_NAME, DB_USER y DB_PASS en monitor/db_config.php.',
                                       'En SiteGround el usuario debe estar asignado a la base con todos los permisos.'], false);

$out = [];
try {
    db_install($pdo);
    $out[] = 'Tablas listas: agentes, llamadas, config.';
    $dir = directory_entries();
    $st = $pdo->prepare('INSERT INTO agentes (extension, nombre) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)');
    foreach ($dir as $ext => $name) $st->execute([$ext, $name]);
    $out[] = count($dir) . ' agente(s) cargados/actualizados desde directory.js.';
    $out[] = 'Agentes en la base: ' . (int)$pdo->query('SELECT COUNT(*) FROM agentes')->fetchColumn() . '.';
    $out[] = 'Llamadas guardadas: ' . (int)$pdo->query('SELECT COUNT(*) FROM llamadas')->fetchColumn() . '.';
    $out[] = is_writable(__DIR__) ? 'La carpeta monitor/ tiene permiso de escritura (actividad en vivo OK).'
                                  : '⚠ La carpeta monitor/ NO tiene permiso de escritura: el panel no verá quién está en línea.';
    page('Base de datos lista', $out, true);
} catch (Exception $e) {
    page('Error al instalar', array_merge($out, [$e->getMessage()]), false);
}
