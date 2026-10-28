<?php
/* ============================================================
   ALLEMM — Conexión a MySQL (PDO) y utilidades comunes
   ============================================================ */

if (file_exists(__DIR__ . '/db_config.php')) {
    require_once __DIR__ . '/db_config.php';
}
if (!defined('TZ_LOCAL')) define('TZ_LOCAL', 'America/Mexico_City');
if (!defined('WEEK_CUT_DOW')) define('WEEK_CUT_DOW', 7);
if (!defined('WEEK_CUT_HOUR')) define('WEEK_CUT_HOUR', 20);
date_default_timezone_set(TZ_LOCAL);

/** Conexión PDO (una por petición). null si no hay base configurada o no conecta. */
function db() {
    static $pdo = false;
    if ($pdo !== false) return $pdo;
    $pdo = null;
    if (!defined('DB_NAME') || !defined('DB_USER')) return null;
    try {
        $pdo = new PDO(
            'mysql:host=' . (defined('DB_HOST') ? DB_HOST : 'localhost') . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER, defined('DB_PASS') ? DB_PASS : '',
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
             PDO::ATTR_EMULATE_PREPARES => false]
        );
        // Las fechas se guardan en hora local (TZ_LOCAL).
        $pdo->exec("SET time_zone = '" . (new DateTime('now'))->format('P') . "'");
    } catch (Exception $e) {
        error_log('ALLEMM monitor: MySQL no conecta: ' . $e->getMessage());
        $pdo = null;
    }
    return $pdo;
}

/** Crea las tablas si no existen (mismo contenido que schema.sql). */
function db_install(PDO $pdo) {
    $sql = file_get_contents(__DIR__ . '/schema.sql');
    $sql = preg_replace('/^\s*--.*$/m', '', $sql);
    foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
        $pdo->exec($stmt);
    }
}

/** Lee window.ALLEMM_DIRECTORY de directory.js → [ext => nombre]. */
function directory_entries() {
    $file = __DIR__ . '/directory.js';
    if (!file_exists($file)) return [];
    $js = preg_replace('#//[^\n]*#', '', file_get_contents($file));
    preg_match_all('/"([^"\\\\]{1,16})"\s*:\s*"((?:[^"\\\\]|\\\\.){1,120})"/u', $js, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $row) $out[$row[1]] = stripcslashes($row[2]);
    return $out;
}

/** Inicio del "periodo semanal" vigente (último corte que ya pasó). */
function week_start($now = null) {
    $tz = new DateTimeZone(TZ_LOCAL);
    $now = $now ?: new DateTime('now', $tz);
    $b = (clone $now)->setTime(WEEK_CUT_HOUR, 0, 0);
    for ($i = 0; $i < 9 && ((int)$b->format('N') !== WEEK_CUT_DOW || $b > $now); $i++) {
        $b->modify('-1 day');
    }
    return $b;
}

function json_out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
