<?php
/* ============================================================
   ALLEMM — Recolector de monitoreo de telefonía
   ------------------------------------------------------------
   POST (teléfonos, REPORT_TOKEN): conectado / heartbeat / desconectado /
        llamada_inicio / llamada_fin. La presencia y la actividad en vivo
        van a un archivo; cada llamada TERMINADA se guarda en MySQL
        (tabla `llamadas`) de forma permanente.
   GET  (panel, ADMIN_TOKEN): en vivo, reportes por rango, agentes y metas.
   POST {action: ...} (panel, ADMIN_TOKEN): editar agentes, metas, semáforo.
   ============================================================ */

require_once __DIR__ . '/db.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('CDN-Cache-Control: no-store');

define('DATA', __DIR__ . '/monitor_data.php');
define('MAX_EVENTS', 300);       // actividad en vivo que se conserva
define('PRESENCE_TTL', 120);     // seg: "en línea" si reportó hace menos de esto
define('MAX_RANGE_DAYS', 400);

/* ---------------- Tokens ---------------- */
$REPORT = defined('REPORT_TOKEN') ? REPORT_TOKEN : (defined('MON_TOKEN') ? MON_TOKEN : '');
$ADMIN  = defined('ADMIN_TOKEN')  ? ADMIN_TOKEN  : (defined('MON_TOKEN') ? MON_TOKEN : '');
if ($REPORT === '' || $ADMIN === '') {
    json_out(['error' => 'sin_configurar', 'detalle' => 'Falta monitor/db_config.php (copiar de db_config.sample.php).'], 503);
}

$method = $_SERVER['REQUEST_METHOD'];
$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input', false, null, 0, 16384);
    $body = json_decode($raw, true);
    if (!is_array($body)) $body = $_POST;
}
$token = (string)($_GET['token'] ?? $body['token'] ?? $_SERVER['HTTP_X_ALLEMM_TOKEN'] ?? '');
$isAdmin = $token !== '' && hash_equals($ADMIN, $token);
$isReporter = $isAdmin || ($token !== '' && hash_equals($REPORT, $token));

/* ---------------- Archivo de actividad en vivo ---------------- */
function load_live() {
    $d = [];
    if (file_exists(DATA)) {
        $raw = file_get_contents(DATA);
        $pos = strpos($raw, "\n");
        $d = json_decode($pos === false ? '' : substr($raw, $pos + 1), true);
        if (!is_array($d)) $d = [];
    }
    $d += ['seq' => 0, 'events' => [], 'presence' => []];
    return $d;
}
function save_live($d) {
    // El "<?php exit;" del inicio impide leer el archivo directo por URL.
    return @file_put_contents(DATA, "<?php exit;?>\n" . json_encode($d)) !== false;
}
function with_lock(callable $fn) {
    $lock = fopen(DATA . '.lock', 'c');
    if ($lock) flock($lock, LOCK_EX);
    try { return $fn(); } finally { if ($lock) { flock($lock, LOCK_UN); fclose($lock); } }
}

/* ---------------- Rango de fechas de los reportes ---------------- */
function parse_range() {
    $tz = new DateTimeZone(TZ_LOCAL);
    $now = new DateTime('now', $tz);
    $r = (string)($_GET['range'] ?? 'week');
    $today = (clone $now)->setTime(0, 0, 0);
    switch ($r) {
        case 'today':     $from = $today; $to = (clone $today)->modify('+1 day'); break;
        case 'yesterday': $to = $today; $from = (clone $today)->modify('-1 day'); break;
        case 'lastweek':  $to = week_start($now); $from = (clone $to)->modify('-7 days'); break;
        case 'month':     $from = (clone $today)->modify('first day of this month'); $to = (clone $from)->modify('+1 month'); break;
        case 'custom':
            $f = DateTime::createFromFormat('!Y-m-d', (string)($_GET['from'] ?? ''), $tz);
            $t = DateTime::createFromFormat('!Y-m-d', (string)($_GET['to'] ?? ''), $tz);
            if (!$f || !$t || $t < $f) json_out(['error' => 'rango'], 400);
            $from = $f; $to = (clone $t)->modify('+1 day');
            if ($from->diff($to)->days > MAX_RANGE_DAYS) json_out(['error' => 'rango_muy_largo'], 400);
            break;
        default:          $r = 'week'; $from = week_start($now); $to = (clone $from)->modify('+7 days');
    }
    // Días transcurridos dentro del rango (para las metas: meta diaria × días).
    $until = $to < $now ? $to : $now;
    $days = $until <= $from ? 0 : (int)ceil(($until->getTimestamp() - $from->getTimestamp()) / 86400);
    return ['range' => $r, 'from' => $from, 'to' => $to, 'days' => $days];
}

function config_values(PDO $pdo) {
    $cfg = ['meta_diaria_default' => 40, 'semaforo_verde' => 100, 'semaforo_amarillo' => 60];
    foreach ($pdo->query('SELECT clave, valor FROM config') as $row) {
        if (array_key_exists($row['clave'], $cfg)) $cfg[$row['clave']] = (int)$row['valor'];
    }
    return $cfg;
}

function need_db() {
    $pdo = db();
    if (!$pdo) json_out(['error' => 'sin_bd', 'detalle' => 'No conecta a MySQL: revisa monitor/db_config.php.'], 503);
    return $pdo;
}

/* ============================================================
   POST
   ============================================================ */
if ($method === 'POST') {
    // ---- Acciones del panel ----
    if (isset($body['action'])) {
        if (!$isAdmin) json_out(['error' => 'token'], 403);
        $pdo = need_db();
        $act = (string)$body['action'];

        if ($act === 'set_agent') {
            $ext = (string)($body['extension'] ?? '');
            $nombre = trim((string)($body['nombre'] ?? ''));
            if (!preg_match('/^[0-9A-Za-z*#]{1,16}$/', $ext) || $nombre === '') json_out(['error' => 'datos'], 400);
            $meta = (isset($body['meta_diaria']) && $body['meta_diaria'] !== '' && $body['meta_diaria'] !== null)
                ? max(0, min(100000, (int)$body['meta_diaria'])) : null;
            $st = $pdo->prepare('INSERT INTO agentes (extension, nombre, equipo, supervisor, meta_diaria, activo)
                                 VALUES (?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), equipo = VALUES(equipo),
                                 supervisor = VALUES(supervisor), meta_diaria = VALUES(meta_diaria), activo = VALUES(activo)');
            $st->execute([$ext, mb_substr($nombre, 0, 120),
                          mb_substr(trim((string)($body['equipo'] ?? '')), 0, 60) ?: null,
                          mb_substr(trim((string)($body['supervisor'] ?? '')), 0, 120) ?: null,
                          $meta, empty($body['activo']) ? 0 : 1]);
            json_out(['ok' => true]);
        }
        if ($act === 'delete_agent') {
            $st = $pdo->prepare('DELETE FROM agentes WHERE extension = ?');
            $st->execute([(string)($body['extension'] ?? '')]);
            json_out(['ok' => true, 'borrados' => $st->rowCount()]);   // sus llamadas se conservan
        }
        if ($act === 'set_config') {
            $allowed = ['meta_diaria_default', 'semaforo_verde', 'semaforo_amarillo'];
            $k = (string)($body['clave'] ?? '');
            if (!in_array($k, $allowed, true)) json_out(['error' => 'clave'], 400);
            $v = max(0, min(100000, (int)($body['valor'] ?? 0)));
            $pdo->prepare('INSERT INTO config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)')
                ->execute([$k, (string)$v]);
            json_out(['ok' => true]);
        }
        json_out(['error' => 'accion'], 400);
    }

    // ---- Reporte de un teléfono ----
    if (!$isReporter) json_out(['error' => 'token'], 403);
    $ext    = substr(preg_replace('/[^0-9A-Za-z*#]/', '', (string)($body['ext'] ?? '')), 0, 16);
    $type   = substr(preg_replace('/[^a-z_]/', '', (string)($body['type'] ?? '')), 0, 24);
    $number = substr(preg_replace('/[^0-9+*#]/', '', (string)($body['number'] ?? '')), 0, 32);
    $dir    = ((string)($body['dir'] ?? '')) === 'entrante' ? 'entrante' : 'saliente';
    $dur    = max(0, min(86400, (int)($body['dur'] ?? 0)));
    $known  = ['conectado', 'heartbeat', 'desconectado', 'llamada_inicio', 'llamada_fin'];
    if ($ext === '' || !in_array($type, $known, true)) json_out(['ok' => false, 'error' => 'datos'], 400);
    $now = time();

    $saved = with_lock(function () use ($ext, $type, $number, $dir, $dur, $now) {
        $d = load_live();
        if ($type === 'desconectado') unset($d['presence'][$ext]);
        else $d['presence'][$ext] = $now;
        if ($type !== 'heartbeat') {
            $d['seq'] = (int)$d['seq'] + 1;
            $d['events'][] = ['id' => $d['seq'], 't' => $now, 'ext' => $ext, 'type' => $type,
                              'num' => $number, 'dir' => $dir, 'dur' => $dur];
            if (count($d['events']) > MAX_EVENTS) $d['events'] = array_slice($d['events'], -MAX_EVENTS);
        }
        foreach ($d['presence'] as $e => $ts) {
            if ($now - $ts > PRESENCE_TTL * 6) unset($d['presence'][$e]);
        }
        return save_live($d);
    });

    $dbSaved = null;
    if ($type === 'llamada_fin') {
        $dbSaved = false;
        $pdo = db();
        if ($pdo) {
            try {
                $pdo->prepare('INSERT INTO llamadas (extension, numero, direccion, duracion, inicio) VALUES (?, ?, ?, ?, ?)')
                    ->execute([$ext, $number !== '' ? $number : null, $dir, $dur, date('Y-m-d H:i:s', $now - $dur)]);
                $dbSaved = true;
            } catch (Exception $e) {
                error_log('ALLEMM monitor: no se guardó la llamada: ' . $e->getMessage());
            }
        }
    }
    json_out(['ok' => $saved, 'bd' => $dbSaved]);
}

/* ============================================================
   GET (solo panel)
   ============================================================ */
if (!$isAdmin) json_out(['error' => 'token'], 403);

// Diagnóstico: collector.php?token=...&diag=1
if (isset($_GET['diag'])) {
    $pdo = db();
    $info = ['carpeta_escribible' => is_writable(__DIR__), 'archivo_vivo' => file_exists(DATA),
             'bd_conecta' => (bool)$pdo, 'zona_horaria' => TZ_LOCAL,
             'semana_desde' => week_start()->format('Y-m-d H:i')];
    if ($pdo) {
        try {
            $info['llamadas_guardadas'] = (int)$pdo->query('SELECT COUNT(*) FROM llamadas')->fetchColumn();
            $info['agentes'] = (int)$pdo->query('SELECT COUNT(*) FROM agentes')->fetchColumn();
        } catch (Exception $e) {
            $info['tablas'] = 'faltan: abre setup_db.php?token=...';
        }
    }
    json_out($info);
}

// Limpiar la lista "en línea" (fantasmas) o toda la actividad en vivo. La BD no se toca.
if (isset($_GET['reset'])) {
    $all = $_GET['reset'] === 'all';
    $ok = with_lock(function () use ($all) {
        $d = load_live();
        $d['presence'] = [];
        if ($all) { $d['events'] = []; }
        return save_live($d);
    });
    json_out(['ok' => $ok, 'reset' => $all ? 'all' : 'presence']);
}

// Agentes + metas + semáforo
if (isset($_GET['agents'])) {
    $pdo = need_db();
    $rows = $pdo->query('SELECT extension, nombre, equipo, supervisor, meta_diaria, activo FROM agentes ORDER BY extension')->fetchAll();
    json_out(['agentes' => $rows, 'config' => config_values($pdo)]);
}

// Reportes (desde MySQL)
if (isset($_GET['report'])) {
    $pdo = need_db();
    $rg = parse_range();
    $from = $rg['from']->format('Y-m-d H:i:s');
    $to = $rg['to']->format('Y-m-d H:i:s');
    $meta = ['range' => $rg['range'], 'from' => $from, 'to' => $to, 'days' => $rg['days']];

    if ($_GET['report'] === 'calls') {
        $sql = 'SELECT l.id, l.extension, a.nombre, l.numero, l.direccion, l.duracion, l.inicio
                FROM llamadas l LEFT JOIN agentes a ON a.extension = l.extension
                WHERE l.inicio >= ? AND l.inicio < ?';
        $args = [$from, $to];
        if (!empty($_GET['ext'])) { $sql .= ' AND l.extension = ?'; $args[] = (string)$_GET['ext']; }
        $st = $pdo->prepare($sql . ' ORDER BY l.inicio DESC LIMIT 20000');
        $st->execute($args);
        json_out($meta + ['calls' => $st->fetchAll()]);
    }

    if ($_GET['report'] === 'people') {
        $cfg = config_values($pdo);
        $st = $pdo->prepare("SELECT extension, COUNT(*) AS total,
                                    SUM(direccion = 'saliente') AS salientes, SUM(direccion = 'entrante') AS entrantes,
                                    SUM(duracion) AS segundos, COUNT(DISTINCT DATE(inicio)) AS dias_activos,
                                    MAX(inicio) AS ultima
                             FROM llamadas WHERE inicio >= ? AND inicio < ? GROUP BY extension");
        $st->execute([$from, $to]);
        $byExt = [];
        foreach ($st as $r) $byExt[$r['extension']] = $r;
        $agents = [];
        foreach ($pdo->query('SELECT * FROM agentes') as $a) $agents[$a['extension']] = $a;

        $people = [];
        foreach (array_unique(array_merge(array_keys($byExt), array_keys(array_filter($agents, function ($a) { return (int)$a['activo'] === 1; })))) as $ext) {
            $c = $byExt[$ext] ?? ['total' => 0, 'salientes' => 0, 'entrantes' => 0, 'segundos' => 0, 'dias_activos' => 0, 'ultima' => null];
            $a = $agents[$ext] ?? null;
            $metaDia = ($a && $a['meta_diaria'] !== null) ? (int)$a['meta_diaria'] : (int)$cfg['meta_diaria_default'];
            $metaTotal = $metaDia * $rg['days'];
            $pct = $metaTotal > 0 ? round(100 * (int)$c['total'] / $metaTotal) : null;
            $color = $pct === null ? 'gris' : ($pct >= $cfg['semaforo_verde'] ? 'verde' : ($pct >= $cfg['semaforo_amarillo'] ? 'amarillo' : 'rojo'));
            $people[] = [
                'extension' => (string)$ext, 'nombre' => $a['nombre'] ?? null, 'equipo' => $a['equipo'] ?? null,
                'supervisor' => $a['supervisor'] ?? null,
                'total' => (int)$c['total'], 'salientes' => (int)$c['salientes'], 'entrantes' => (int)$c['entrantes'],
                'segundos' => (int)$c['segundos'], 'dias_activos' => (int)$c['dias_activos'], 'ultima' => $c['ultima'],
                'meta_diaria' => $metaDia, 'meta_total' => $metaTotal, 'avance' => $pct, 'semaforo' => $color,
            ];
        }
        usort($people, function ($x, $y) { return [$y['total'], $y['segundos']] <=> [$x['total'], $x['segundos']]; });
        json_out($meta + ['people' => $people, 'config' => $cfg]);
    }
    json_out(['error' => 'reporte'], 400);
}

// En vivo: eventos nuevos (después del id `after`) + quién está en línea
$after = (int)($_GET['after'] ?? 0);
$d = load_live();
$now = time();
$events = array_values(array_filter($d['events'], function ($e) use ($after) { return (int)($e['id'] ?? 0) > $after; }));
$online = [];
foreach ($d['presence'] as $e => $ts) {
    if ($now - $ts <= PRESENCE_TTL) $online[] = (string)$e;
}
sort($online);
json_out(['now' => $now, 'seq' => (int)$d['seq'], 'events' => $events, 'online' => $online,
          'semana_desde' => week_start()->format('Y-m-d H:i')]);
