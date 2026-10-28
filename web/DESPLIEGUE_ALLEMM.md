# Telefonía web ALLEMM — Despliegue

Sistema independiente de UVAC: su propio conmutador, servidor, base de datos,
tokens y agentes. Nada de aquí apunta al conmutador ni al servidor de UVAC.

```
tu-servidor/telefonia/
├── index.html              ← softphone (WebApp, instalable en iPhone)
├── js/allemm-config.js     ← ⚙ conmutador + recolector (SE EDITA AQUÍ)
├── js/ …                   ← motor (JsSIP + WebRTC) e interfaz
├── monitor/
│   ├── collector.php       ← recolector (teléfonos → archivo en vivo + MySQL)
│   ├── db.php              ← conexión PDO
│   ├── db_config.php       ← ⚙ credenciales MySQL + tokens (NO va a GitHub)
│   ├── db_config.sample.php← plantilla
│   ├── setup_db.php        ← instalador de un clic (tablas + agentes)
│   ├── schema.sql          ← SQL para phpMyAdmin
│   └── directory.js        ← extensión → nombre de los agentes
└── admin/admin.html        ← panel de administración
```

## 1. Lo que entrega el proveedor del conmutador (bloqueante)

1. Servidor WSS: `pbxXXXXX.pbxhosting.com.mx` (el de ALLEMM).
2. Puerto WSS (normalmente `8089`; pedir `443` si lo ofrecen: casi ninguna red lo bloquea).
3. Ruta (normalmente `/ws`).
4. Extensiones y contraseñas SIP de los agentes, con **WebRTC habilitado**.
5. Certificado SSL válido en el conmutador (WSS/WebRTC lo exige).

## 2. Subir los archivos

Subir el contenido del paquete `AllemmSIP-web` a una carpeta con **HTTPS**
(p. ej. `https://allemm.com.mx/telefonia/`). Sin HTTPS el navegador bloquea el micrófono.

## 3. Configurar (solo dos archivos)

**`js/allemm-config.js`**: el conmutador y el recolector.
```js
window.ALLEMM_WEB_CONFIG = {
    sipServer: 'pbxXXXXX.pbxhosting.com.mx',
    wssPort: 8089,
    wssPath: '/ws',
    monitorUrl: 'monitor/collector.php',
    monitorToken: '<REPORT_TOKEN>'
};
```
Los teléfonos lo leen cada vez que abren la app: cambiar el conmutador es editar
este archivo, sin recompilar.

**`monitor/db_config.php`**: copiar de `db_config.sample.php` y llenar.
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`: la base MySQL de ALLEMM.
- `REPORT_TOKEN`: el mismo de `monitorToken`. Solo sirve para **reportar**.
- `ADMIN_TOKEN`: solo para el panel. Con él se **leen** reportes y se editan metas;
  no se reparte a los agentes.
- `TZ_LOCAL`, `WEEK_CUT_DOW`, `WEEK_CUT_HOUR`: zona horaria y corte semanal
  (por defecto domingo 20:00). El corte **no borra nada**: solo define "esta semana".

> A diferencia de UVAC, son **dos tokens**: el de reporte está a la vista en la
> página del teléfono, así que no debe servir para leer los reportes.

## 4. Base de datos (SiteGround)

1. *Site Tools → MySQL → Databases*: crear la base y un usuario; asignar el
   usuario a la base con todos los permisos.
2. Abrir `https://…/telefonia/monitor/setup_db.php?token=<ADMIN_TOKEN>`.
   Crea las tablas `agentes`, `llamadas` y `config`, y carga los agentes de
   `directory.js`. Se puede abrir las veces que sea: no duplica ni borra.
   (Alternativa: pegar `schema.sql` en phpMyAdmin.)
3. La carpeta `monitor/` debe tener permiso de escritura (la actividad en vivo
   se guarda en `monitor_data.php`; `setup_db.php` avisa si falta).

## 5. Panel de administración

`https://…/telefonia/admin/admin.html`: pide el `ADMIN_TOKEN` una vez y lo
recuerda en ese navegador.

- **En línea** y **llamadas en curso**, en vivo (cada 3 s).
- **Registro por día** (acordeón) con filtro por agente.
- **Por persona**: ranking, salientes/entrantes, tiempo, promedio, meta del
  periodo, avance y semáforo.
- Rangos: hoy, ayer, esta semana, semana pasada, este mes o fechas a elegir.
- **Agentes y metas**: alta, edición y baja de agentes; meta diaria por agente
  o por defecto, y umbrales del semáforo. Las llamadas de un agente dado de baja
  se conservan.
- **Excel/CSV** de llamadas y de por persona.
- Mantenimiento: limpiar "fantasmas" en línea y diagnóstico.

Recomendado: proteger `admin/` con contraseña del servidor (*Site Tools →
Security → Protected URLs*).

## 6. Prueba de arranque

1. Un agente inicia sesión en `https://…/telefonia/` y hace una llamada.
2. En el panel aparece en línea y con la llamada en curso.
3. Al colgar, la llamada aparece en el registro del día (y en la tabla `llamadas`).

Diagnóstico rápido: `monitor/collector.php?token=<ADMIN_TOKEN>&diag=1`.

## 7. Seguridad

- `monitor/db_config.php` nunca se sube a GitHub (está en `.gitignore`) ni va
  en los paquetes de GitHub Actions.
- `monitor/.htaccess` bloquea la lectura directa de `db_config.php`, `db.php`,
  `schema.sql`, `directory.js` y el archivo de actividad en vivo.
- En producción, *Ajustes → Registro detallado* debe estar apagado (los logs de
  JsSIP incluyen cabeceras de autenticación SIP).

## Notas

- La duración que se guarda es desde que empieza a marcar o sonar hasta que se
  cuelga (mismo criterio que UVAC). Las llamadas no contestadas también quedan
  registradas.
- El `.exe` y el APK pueden reportar al mismo panel: en *Ajustes → Panel de
  monitoreo* poner la URL completa de `monitor/collector.php` y el `REPORT_TOKEN`.
- Límite de iPhone: las llamadas entran solo con la app abierta en pantalla.
