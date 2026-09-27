# Publicar CernoIA en cernoia.secretbloom.tech con CloudPanel

Esta guía corresponde al entorno confirmado:

- VPS Hostinger con Ubuntu 24.04;
- CloudPanel y Nginx activos;
- otros sitios WordPress en el mismo servidor;
- n8n activo en `https://n8n.secretbloom.tech`;
- subdominio `cernoia.secretbloom.tech` administrado donde esté el DNS de `secretbloom.tech`.

El procedimiento no reemplaza Nginx, no instala Docker y no modifica los Vhosts de WordPress.

## Antes de comenzar

Necesitas tener a mano:

1. el paquete de CernoIA validado;
2. la URL de conexión de PostgreSQL usada por CernoIA;
3. acceso a GoDaddy;
4. acceso a CloudPanel;
5. acceso a n8n;
6. el UUID de una organización existente o permiso para crearla;
7. llaves de pruebas de Bold;
8. credenciales SMTP y/o WhatsApp si se enviarán avisos externos;
9. una contraseña nueva para Redis.

> Los comandos `chmod`, `./archivo.sh`, `su` y `nano` son de Linux. No se ejecutan en `C:\Users\...`. En Windows solo debes descargar/subir el ZIP o conectarte por SSH.

## Paso 1 — Apuntar el dominio desde GoDaddy

En el proveedor DNS de `secretbloom.tech`, crea o edita únicamente el registro del subdominio.

Deja intactos los registros MX y TXT de correo. Crea o edita únicamente estos registros:

| Tipo | Nombre | Valor | TTL |
|---|---|---|---|
| A | `cernoia` | `187.124.233.157` | 300 |

Si ya existe otro registro A para `@` o un registro para `www` que apunta a otro servicio, reemplázalo. No debe quedar un registro AAAA antiguo para `@` o `www` si no tienes IPv6 configurado en este VPS.

La propagación normalmente es rápida, pero puede tardar hasta 48 horas. Puedes comprobarla desde la terminal del VPS:

```bash
getent ahostsv4 cernoia.secretbloom.tech | head
```

En ambas respuestas debe aparecer `187.124.233.157` antes de solicitar el certificado.

## Paso 2 — Crear el sitio Node.js en CloudPanel

1. Abre CloudPanel en `https://187.124.233.157:8443`.
2. Entra en **Sites**.
3. Pulsa **+ Add Site**.
4. Selecciona **Create a Node.js Site**.
5. Completa:

| Campo | Valor |
|---|---|
| Domain Name | `cernoia.secretbloom.tech` |
| Node.js Version | `22` |
| App Port | `3000` |
| Site User | puedes usar `cernoia` |
| Site User Password | una contraseña nueva y segura |

6. Pulsa **Create** y guarda el nombre exacto del Site User.

CloudPanel crea una cuenta Linux aislada para este sitio. El Node 18 que viste como `root` no se usa: la aplicación debe ejecutarse con el Site User y Node 22.

## Paso 3 — Subir el proyecto

En CloudPanel abre el sitio `cernoia.secretbloom.tech` y entra en **File Manager**. La carpeta del sitio será parecida a:

```text
/home/cernoia/htdocs/cernoia.secretbloom.tech
```

1. Entra en esa carpeta.
2. Si existe un archivo de bienvenida como `index.html`, renómbralo a `index.cloudpanel.bak`.
3. Sube el paquete validado de CernoIA.
4. Usa **Extract** y verifica que `package.json`, `app`, `backend` y `deploy` queden directamente dentro de `cernoia.secretbloom.tech`, no dentro de una segunda carpeta.

La estructura correcta empieza así:

```text
cernoia.secretbloom.tech/
├── app/
├── backend/
├── deploy/
├── package.json
└── package-lock.json
```

## Paso 3A — Instalar dependencias del sistema sin tocar los sitios

Este paso se realiza una sola vez como `root`. Instala utilidades usadas por CernoIA; no reemplaza Nginx, PHP, MySQL ni los Vhosts existentes:

```bash
sudo apt-get update
sudo apt-get install -y postgresql-client redis-server poppler-utils clamav clamav-daemon
```

Confirma los servicios:

```bash
sudo systemctl enable --now redis-server
sudo systemctl enable --now clamav-daemon
sudo systemctl is-active redis-server
sudo systemctl is-active clamav-daemon
```

Redis se protege siguiendo `docs/FASE_2_REDIS_ALERTAS_PROPUESTAS.md`. No abras el puerto 6379.

La API usa el protocolo INSTREAM de ClamAV por localhost. Abre `/etc/clamav/clamd.conf`, conserva la configuración existente y agrega una sola vez:

```conf
TCPSocket 3310
TCPAddr 127.0.0.1
```

Reinicia únicamente ClamAV y comprueba que no escucha públicamente:

```bash
sudo systemctl restart clamav-daemon
sudo ss -lntp | grep ':3310\b'
```

La dirección debe ser `127.0.0.1:3310`, nunca `0.0.0.0:3310`. El primer OCR en español puede tardar más porque Tesseract.js prepara el modelo; el VPS necesita acceso HTTPS saliente.

## Paso 4 — Entrar como Site User

Tu terminal de Hostinger entra como `root`. Cambia al usuario del sitio; reemplaza `cernoia` si elegiste otro nombre:

```bash
su - cernoia
cd htdocs/cernoia.secretbloom.tech
whoami
node -v
pwd
```

Debes ver:

- `whoami`: `cernoia`;
- `node -v`: `v22...` o superior;
- `pwd`: `/home/cernoia/htdocs/cernoia.secretbloom.tech`.

No continúes si aparece `root` o Node 18. Corrige la versión en **CloudPanel → Sites → cernoia.secretbloom.tech → Settings → Node.js Settings**, cierra la sesión SSH y vuelve a entrar.

## Paso 5 — Crear la configuración privada

Ejecuta:

```bash
cp backend/.env.example backend/.env
openssl rand -hex 48
openssl rand -hex 32
openssl rand -hex 40
nano backend/.env
```

Los tres comandos `openssl` muestran valores distintos. Usa el primero como `JWT_SECRET`, el segundo como `DATA_ENCRYPTION_KEY` y el tercero como `N8N_WEBHOOK_SECRET`. No publiques esos valores ni los envíes por chat.

El archivo debe conservar esta forma, sustituyendo solo los valores indicados:

```dotenv
NODE_ENV=production
PORT=4001
DATABASE_URL=postgresql://USUARIO:CLAVE@HOST:5432/BASE_DE_DATOS
DATABASE_SSL=false
JWT_SECRET=PEGA_AQUI_EL_PRIMER_SECRETO
SESSION_TTL_HOURS=8
PASSWORD_RESET_TTL_MINUTES=30
COOKIE_NAME=__Host-cernoia_session
CSRF_COOKIE_NAME=__Host-cernoia_csrf
APP_ORIGIN=https://cernoia.secretbloom.tech
ALLOWED_ORIGINS=https://cernoia.secretbloom.tech
DATA_ENCRYPTION_KEY=PEGA_AQUI_EL_SEGUNDO_SECRETO_DE_64_HEXADECIMALES
DOCUMENT_STORAGE_PATH=/home/cernoia/private/cernoia-documents
DOCUMENT_UPLOAD_MAX_MB=20
SIGNATURE_UPLOAD_MAX_MB=3
TEMPLATE_UPLOAD_MAX_MB=10
OCR_ENABLED=true
OCR_LANGUAGE=spa+eng
OCR_MAX_PAGES=8
OCR_MAX_IMAGE_PIXELS=12000000
CLAMAV_ENABLED=true
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
MALWARE_SCAN_REQUIRED=true
REDIS_URL=redis://:CLAVE_REDIS@127.0.0.1:6379/0
CHAT_MESSAGES_PER_HOUR=20
CHAT_MAX_PROMPT_CHARS=4000
CHAT_WORKFLOW_TIMEOUT_MS=60000
SUBSCRIPTION_ENFORCED=false
INTERNAL_API_BASE_URL=http://127.0.0.1:4001
N8N_BASE_URL=https://n8n.secretbloom.tech
N8N_HEALTH_URL=https://n8n.secretbloom.tech/healthz
N8N_API_KEY=API_KEY_N8N_SOLO_PARA_INVENTARIO
N8N_WF019_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-019
N8N_WF011_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-011
N8N_WF022_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-022
N8N_WF023_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-023
N8N_WF024_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-024
N8N_WF005_WEBHOOK_URL=
N8N_WF014_WEBHOOK_URL=
N8N_WF015_WEBHOOK_URL=
N8N_WEBHOOK_SECRET=PEGA_AQUI_EL_TERCER_SECRETO
N8N_TIMEOUT_MS=15000
BOLD_ENVIRONMENT=test
BOLD_API_BASE_URL=https://integrations.api.bold.co
BOLD_IDENTITY_KEY=LLAVE_DE_IDENTIDAD_BOLD
BOLD_SECRET_KEY=LLAVE_SECRETA_BOLD
BOLD_CHECKOUT_TTL_MINUTES=30
BOLD_CALLBACK_URL=https://cernoia.secretbloom.tech/?billing=return
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
NOTIFICATION_FROM_EMAIL=
WHATSAPP_GRAPH_API_VERSION=v23.0
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
NOTIFICATION_WORKER_BATCH=20
```

Notas:

- Si PostgreSQL está en el mismo VPS, normalmente `HOST` es `127.0.0.1` y `DATABASE_SSL=false`.
- Si la contraseña de PostgreSQL contiene `@`, `:`, `/`, `#` u otros símbolos reservados, debe codificarse para una URL.
- Puedes dejar las URLs n8n vacías únicamente durante la primera comprobación de salud. Antes de la prueba funcional deben estar publicados WF-011, WF-019, WF-022, WF-023 y WF-024.
- Mantén `SUBSCRIPTION_ENFORCED=false` durante la aceptación de Bold. Cámbialo a `true` solo después de comprobar aprobación, duplicado, rechazo y renovación.
- Si aún no usarás correo o WhatsApp, deja esas credenciales vacías; la bandeja dentro de CernoIA seguirá funcionando.
- En `nano`, guarda con `Ctrl+O`, Enter y sal con `Ctrl+X`.

Protege el archivo:

```bash
chmod 600 backend/.env
```

## Paso 6 — Instalar y arrancar sin tocar WordPress

Todavía como Site User y dentro de la carpeta del proyecto, ejecuta:

```bash
bash deploy/install-cloudpanel.sh
```

Este instalador:

- comprueba Node 22;
- instala dependencias;
- crea el almacenamiento privado;
- compila el frontend;
- aplica las migraciones;
- inicia `cernoia-frontend` en `127.0.0.1:3000`;
- inicia `cernoia-api` en `127.0.0.1:4001`;
- guarda ambos procesos en PM2.

Comprueba:

```bash
pm2 status
curl http://127.0.0.1:4001/api/health
curl -I http://127.0.0.1:3000
```

La API debe responder con `"status":"ok"` y ambos procesos deben aparecer `online`.

### Hacer que PM2 vuelva después de un reinicio

CloudPanel recomienda restaurar PM2 desde el `crontab` del Site User. Primero copia el resultado completo de:

```bash
echo $PATH
```

Después abre:

```bash
crontab -e
```

Si pregunta por un editor, selecciona `nano`. Al final agrega estas dos líneas, reemplazando el valor de la primera por el resultado real de `echo $PATH`:

```cron
  PATH=/home/cernoia/.nvm/versions/node/v22.x.x/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
@reboot pm2 resurrect >/dev/null 2>&1
```

Guarda con `Ctrl+O`, Enter y `Ctrl+X`. Comprueba que quedó registrado:

```bash
crontab -l
```

## Paso 7 — Crear el primer acceso

Lista las organizaciones existentes:

```bash
npm --prefix backend run list-organizations
```

Copia el UUID correcto. Luego crea el propietario sin dejar su contraseña en el historial de comandos:

```bash
read -rsp "Contraseña inicial: " CERNOIA_ADMIN_PASSWORD; echo
export CERNOIA_ADMIN_PASSWORD
npm --prefix backend run create-admin -- --email=TU_CORREO --name="TU NOMBRE" --organization=PEGA_AQUI_EL_UUID
unset CERNOIA_ADMIN_PASSWORD
```

La contraseña debe tener al menos 12 caracteres e incluir letras y números.

## Paso 8 — Enrutar `/api` desde el Vhost de CloudPanel

CloudPanel ya envía el sitio principal al puerto 3000. Solo falta que `/api` vaya al puerto 4001.

1. En CloudPanel abre **Sites → cernoia.secretbloom.tech → Vhost**.
2. Haz una copia del texto actual en un archivo local antes de editar.
3. Busca el bloque que empieza con `location / {`.
4. Inmediatamente **antes** de ese bloque, pega el contenido de `deploy/cloudpanel-api-location.conf`, desde `location ^~ /api/ {` hasta su llave final.
5. Pulsa **Save**.

No reemplaces el Vhost completo y no edites los archivos de los dominios WordPress. CloudPanel valida la sintaxis y revierte cambios inválidos.

Comprueba desde la terminal:

```bash
curl -I -H 'Host: cernoia.secretbloom.tech' http://127.0.0.1/
curl -H 'Host: cernoia.secretbloom.tech' http://127.0.0.1/api/health
```

## Paso 9 — Activar SSL HTTPS

Hazlo solo cuando el DNS del paso 1 ya responda con la IP del VPS.

1. En CloudPanel abre **Sites → cernoia.secretbloom.tech → SSL/TLS**.
2. Pulsa **Actions → New Let's Encrypt Certificate**.
3. Incluye únicamente `cernoia.secretbloom.tech`.
4. Pulsa **Create and Install**.

CloudPanel instalará el certificado y redirigirá HTTP a HTTPS. No ejecutes Certbot manualmente para este sitio.

Comprueba:

```bash
curl -I https://cernoia.secretbloom.tech
curl https://cernoia.secretbloom.tech/api/health
```

## Paso 10 — Conectar n8n

Antes de activar los workflows de IA, instala y protege Redis siguiendo `docs/FASE_2_REDIS_ALERTAS_PROPUESTAS.md`. No abras el puerto 6379 al exterior.

La ruta correcta es:

```text
Navegador → https://cernoia.secretbloom.tech/api → API privada → https://n8n.secretbloom.tech
```

No se crea una ruta pública `/n8n` en `cernoia.secretbloom.tech` y el navegador nunca recibe el secreto compartido.

En n8n:

1. importa las 23 exportaciones y publica en el orden de `n8n/workflow-manifest.json`;
2. publica los webhooks de producción `cernoia/wf-011`, `cernoia/wf-019`, `cernoia/wf-022`, `cernoia/wf-023` y `cernoia/wf-024`;
3. usa autenticación Header Auth;
4. configura `Authorization` como `Bearer ` seguido del mismo `N8N_WEBHOOK_SECRET` de `backend/.env`;
5. conecta WF-020 como controlador previo de todas las llamadas Gemini, incluido el chat;
6. asegúrate de conservar `organization_id` dentro de `metadata` al registrar `ops.workflow_runs`.

El último punto es obligatorio: la API oculta deliberadamente cualquier ejecución que no tenga el `organization_id` correcto para evitar filtraciones entre clientes.

Consulta también `n8n/INTEGRACION_WF019.md`.

## Paso 10A — Conectar Bold sin habilitar cobro obligatorio

1. Obtén en el panel Bold una llave de identidad y una llave secreta de pruebas.
2. Mantén `BOLD_ENVIRONMENT=test` y `SUBSCRIPTION_ENFORCED=false`.
3. Registra este endpoint HTTPS:

```text
https://cernoia.secretbloom.tech/api/billing/webhooks/bold
```

4. Coloca las llaves únicamente en `backend/.env` y reinicia `cernoia-api` con `--update-env`.
5. Genera el link desde **Facturación** y usa el flujo de prueba de Bold.
6. Comprueba en PostgreSQL que el evento quedó persistido una sola vez y que monto/moneda coinciden.
7. Prueba aprobación, rechazo, firma inválida y evento duplicado.

Bold documenta `POST /online/link/v1`, el máximo de 100 caracteres de la descripción y la autenticación con llave de identidad en su [API Link de pagos](https://developers.bold.co/pagos-en-linea/api-link-de-pagos). La [guía oficial de webhooks](https://developers.bold.co/webhook) exige verificar el HMAC del cuerpo Base64 y recomienda idempotencia. En modo de pruebas las notificaciones automáticas pueden no enviarse; usa la opción de probar webhook indicada por Bold.

Cuando toda la aceptación pase, cambia a las llaves/entorno habilitados por Bold. Solo entonces establece `SUBSCRIPTION_ENFORCED=true` y reinicia la API. La redirección `?billing=return` nunca activa una cuenta.

## Paso 11 — Prueba funcional antes de compartir el dominio

Realiza estas pruebas en orden:

1. abre `https://cernoia.secretbloom.tech` y confirma el candado;
2. inicia sesión;
3. abre Oportunidades y verifica que solo aparecen datos de la organización;
4. carga un PDF pequeño en Documentos;
5. descárgalo de nuevo;
6. cambia su estado o agrega una nota a una oportunidad;
7. cambia la contraseña y confirma que otra sesión se cierre;
8. inicia una actualización desde Automatización;
9. revisa n8n y luego el historial de la aplicación;
10. revisa en móvil que no haya desplazamiento horizontal;
11. ejecuta WF-021 y confirma las alertas documentales;
12. configura una política y comprueba avisos de vencimiento en los días elegidos;
13. prueba OCR/revisión con PDF escaneado e imagen, y rechazo con antivirus no disponible;
14. genera y descarga un paquete preliminar desde **Preparar propuesta**;
15. carga una plantilla DOCX/PDF y valida autollenado y campos pendientes;
16. prueba la firma electrónica solo con una cuenta autorizada y consentimiento por paquete;
17. consulta Chat CernoIA, exige fuentes y prueba cuota agotada/instrucción adversarial;
18. contrasta el mapa nacional, un departamento, un municipio y una pagaduría contra SQL;
19. prueba MFA, recuperación de contraseña y un canal de notificación verificado;
20. prueba Bold con aprobación/rechazo/duplicado y confirma los cupos fundador 1, 100 y 101 en una base de ensayo;
21. revisa **Centro operativo** y confirma que no quedan trabajos inesperados en la DLQ;
22. ejecuta un backup y restáuralo en una base distinta antes de invitar clientes.

## Operación y actualizaciones

Comandos habituales, siempre como Site User:

```bash
cd ~/htdocs/cernoia.secretbloom.tech
pm2 status
pm2 logs cernoia-api --lines 100
pm2 logs cernoia-frontend --lines 100
pm2 restart cernoia-api
pm2 restart cernoia-frontend
```

Para instalar una versión nueva:

```bash
cd ~/htdocs/cernoia.secretbloom.tech
bash deploy/install-cloudpanel.sh
```

Antes de reemplazar archivos, conserva una copia del ZIP anterior y un respaldo de PostgreSQL.

### Backups y prueba de restauración

Crea una carpeta privada como Site User:

```bash
mkdir -p /home/cernoia/private/backups
chmod 700 /home/cernoia/private/backups
chmod +x deploy/backup-cernoia.sh deploy/restore-cernoia.sh
```

Prueba un respaldo manual:

```bash
./deploy/backup-cernoia.sh \
  /home/cernoia/htdocs/cernoia.secretbloom.tech \
  /home/cernoia/htdocs/cernoia.secretbloom.tech/backend/.env \
  /home/cernoia/private/backups
```

El archivo incluye `pg_dump`, documentos, manifiesto y checksums; excluye `.env`. Programa una ejecución diaria en el `crontab` del Site User y revisa espacio/resultado:

```cron
15 3 * * * /home/cernoia/htdocs/cernoia.secretbloom.tech/deploy/backup-cernoia.sh /home/cernoia/htdocs/cernoia.secretbloom.tech /home/cernoia/htdocs/cernoia.secretbloom.tech/backend/.env /home/cernoia/private/backups >> /home/cernoia/private/backup.log 2>&1
```

Copia respaldos a un destino fuera del VPS y define retención antes del lanzamiento. Una copia en el mismo disco no protege frente a pérdida total del servidor.

Para probar la restauración, crea una base y un `.env` exclusivos de ensayo. Nunca uses la base de producción. El comando exige escribir exactamente `RESTORE-CERNOIA-NOMBRE_BASE` y genera otro dump antes de limpiar el destino:

```bash
./deploy/restore-cernoia.sh \
  /home/cernoia/private/backups/ARCHIVO.tar.gz \
  /RUTA/DE/ENSAYO/backend/.env \
  RESTORE-CERNOIA-NOMBRE_BASE_ENSAYO
```

## Cuando compres CernoIA.com

No es necesario reconstruir la aplicación. Primero apunta el nuevo dominio al mismo VPS y crea el nuevo sitio/alias en CloudPanel. Después cambia en `backend/.env`:

```dotenv
APP_ORIGIN=https://cernoia.com
ALLOWED_ORIGINS=https://cernoia.com,https://www.cernoia.com
```

Reinicia con:

```bash
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
```

Mantén el entorno de prueba en `cernoia.secretbloom.tech` hasta validar el dominio final; no sirvas dos dominios en paralelo sin actualizar la política de cookies y origen.

## Si algo falla

No cambies Nginx global ni reinicies los sitios WordPress. Reúne únicamente estas salidas, ocultando secretos:

```bash
whoami
node -v
pwd
pm2 status
pm2 logs cernoia-api --lines 50
pm2 logs cernoia-frontend --lines 50
curl http://127.0.0.1:4001/api/health
```

Nunca pegues `backend/.env`, `DATABASE_URL`, `JWT_SECRET` ni `N8N_WEBHOOK_SECRET` en una conversación o captura pública.
