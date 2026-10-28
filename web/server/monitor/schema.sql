-- ============================================================
-- ALLEMM — Telefonía: base de datos de monitoreo (MySQL / MariaDB)
-- Pegar en phpMyAdmin (pestaña SQL) sobre la base de ALLEMM,
-- o abrir monitor/setup_db.php?token=<ADMIN_TOKEN> (hace lo mismo).
-- ============================================================

CREATE TABLE IF NOT EXISTS agentes (
  extension VARCHAR(16) NOT NULL PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  equipo VARCHAR(60) NULL,
  supervisor VARCHAR(120) NULL,
  meta_diaria INT NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS llamadas (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  extension VARCHAR(16) NOT NULL,
  numero VARCHAR(32) NULL,
  direccion VARCHAR(10) NOT NULL DEFAULT 'saliente',  -- saliente | entrante
  duracion INT NOT NULL DEFAULT 0,                     -- segundos
  inicio DATETIME NOT NULL,                            -- hora de la llamada (hora local)
  creado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ext (extension),
  INDEX idx_inicio (inicio),
  INDEX idx_ext_inicio (extension, inicio)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS config (
  clave VARCHAR(40) NOT NULL PRIMARY KEY,
  valor VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Valores iniciales del panel (no pisa los que ya existan)
INSERT IGNORE INTO config (clave, valor) VALUES
  ('meta_diaria_default', '40'),
  ('semaforo_verde', '100'),
  ('semaforo_amarillo', '60');
