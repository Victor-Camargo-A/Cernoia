# Fase 2 — Redis, alertas, propuestas y firma

Esta guía completa la instalación técnica agregada después de la auditoría inicial. Está diseñada para el VPS actual con Ubuntu 24.04, CloudPanel, Nginx, WordPress existentes y n8n en `n8n.secretbloom.tech`.

Esta sigue siendo la referencia detallada de Redis/firma. Para el alcance completo actual —incluidos Bold, chat, mapa, OCR y notificaciones— usa primero `docs/IMPLEMENTACION_PUNTOS_2_A_8.md` y `docs/DESPLIEGUE_CLOUDPANEL_AGENTGLOBAL.md`.

No ejecutes estos pasos desde CMD de Windows. Cuando llegue el momento de instalar, hazlo en la terminal del VPS y conserva primero un respaldo de PostgreSQL y de los workflows n8n.

## 1. Arquitectura resultante

```text
Frontend CernoIA
  ├─ carga documento ───────→ API privada ─→ almacenamiento privado
  │                                           └─ webhook WF-011
  ├─ consulta alertas ──────→ API ← PostgreSQL ← WF-021 diario
  └─ prepara propuesta ─────→ API ─→ webhook WF-022 ─→ API renderiza PDF
                                     │
                                     └─ WF-020 ─→ Redis (RPM/RPD)
                                           ↑
                          WF-008 / WF-011 / WF-015 / WF-021 / WF-022
```

Redis en esta arquitectura funciona como **control atómico de llamadas a Gemini**. No convierte por sí solo a n8n en modo cola ni sustituye la base de datos. El modo cola de n8n es una decisión separada y no es necesario para esta primera publicación.

## 2. Comprobar si Redis ya existe

Como `root` en la terminal del VPS:

```bash
command -v redis-server
sudo systemctl is-active redis-server
sudo ss -lntp | grep ':6379\b'
```

- Si aparece activo y escuchando solo en `127.0.0.1:6379` o `[::1]:6379`, no instales una segunda copia.
- Si escucha en `0.0.0.0:6379`, detente: primero debe cerrarse el acceso público.
- Si no existe, continúa con el siguiente punto.

## 3. Instalar Redis sin modificar Nginx ni WordPress

Como `root`:

```bash
sudo apt-get update
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server
```

Abre la configuración:

```bash
sudo nano /etc/redis/redis.conf
```

Confirma que estas directivas existan una sola vez:

```conf
bind 127.0.0.1 -::1
protected-mode yes
supervised systemd
```

Genera una contraseña distinta de las de PostgreSQL, JWT y n8n:

```bash
openssl rand -hex 32
```

Guárdala de forma privada. En `redis.conf`, agrega o reemplaza:

```conf
requirepass PEGA_AQUI_LA_CLAVE_REDIS
```

Reinicia únicamente Redis:

```bash
sudo systemctl restart redis-server
sudo systemctl is-active redis-server
sudo ss -lntp | grep ':6379\b'
```

El puerto 6379 no debe abrirse en el firewall ni publicarse mediante CloudPanel.

Prueba de forma interactiva para no dejar la contraseña dentro del historial del comando:

```bash
redis-cli
```

Dentro de `redis-cli`:

```text
AUTH PEGA_AQUI_LA_CLAVE_REDIS
PING
QUIT
```

La respuesta esperada a `PING` es `PONG`.

## 4. Aplicar las migraciones

Como el Site User de `agentglobal.online`:

```bash
cd ~/htdocs/agentglobal.online
npm --prefix backend run migrate
```

Se aplican de forma idempotente las migraciones `000` a `008`. Además de las piezas originales, las dos migraciones finales agregan suscripciones, Bold, chat, notificaciones, MFA, OCR/revisión y plantillas:

- perfiles privados de firma;
- alertas documentales y resúmenes;
- paquetes de propuesta;
- eventos y políticas de cuota de IA;
- tipo de proponente confirmado por la organización.

Comprueba la política inicial desde PostgreSQL con la herramienta que ya uses:

```sql
SELECT provider, model_name, rpm_limit, rpd_limit, is_active
FROM ops.ai_quota_policies;
```

Los valores iniciales de 8 RPM y 400 RPD son conservadores. Sustitúyelos por los límites vigentes que muestre Google AI Studio para el proyecto y modelo conectados. Las cuotas de Google pueden variar por modelo, nivel y proyecto.

## 5. Crear la credencial Redis en n8n

En `https://n8n.secretbloom.tech`:

1. abre **Credentials**;
2. pulsa **Add credential**;
3. selecciona **Redis**;
4. usa:

| Campo | Valor |
|---|---|
| Nombre | `CernoIA Redis` |
| Host | `127.0.0.1` |
| Port | `6379` |
| Database Number | `0` |
| Password | la clave creada en el paso 3 |
| SSL | desactivado para la conexión local |

Guarda y prueba la conexión. Después de importar WF-020, selecciona esta credencial en sus dos nodos Redis.

## 6. Credencial de integración privada

En n8n debe existir una credencial **Header Auth**:

| Campo | Valor |
|---|---|
| Nombre | `CernoIA Webhook Secret` |
| Header Name | `Authorization` |
| Header Value | `Bearer ` seguido exactamente de `N8N_WEBHOOK_SECRET` |

Se usa en los webhooks WF-011, WF-019, WF-022, WF-023 y WF-024, y también en las llamadas privadas de n8n hacia la API. El secreto nunca debe llegar al navegador.

## 7. Importar y enlazar workflows

Importa los 23 JSON de `n8n/workflows/`. Todos comienzan con `[CernoIA PROD]` y llegan inactivos.

Asigna credenciales:

- PostgreSQL: todos los nodos PostgreSQL;
- Gemini: WF-008, WF-011, WF-015, WF-021, WF-022 y WF-023;
- Redis: los dos contadores de WF-020;
- Header Auth: webhooks/callbacks de WF-011, WF-019, WF-022, WF-023 y WF-024.

Después de una importación visual, vuelve a seleccionar desde el desplegable:

- WF-020 dentro de WF-008, WF-011, WF-015, WF-021 y WF-022;
- WF-020 dentro de WF-023;
- las doce etapas dentro de WF-019;
- WF-007 como workflow de error donde corresponda.

Activa en el orden exacto de `n8n/workflow-manifest.json`. WF-000 permanece inactivo.

## 8. Configurar la API

En `backend/.env` confirma:

```dotenv
SIGNATURE_UPLOAD_MAX_MB=3
N8N_WF011_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-011
N8N_WF019_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-019
N8N_WF022_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-022
N8N_WF023_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-023
N8N_WF024_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-024
N8N_WEBHOOK_SECRET=EL_MISMO_SECRETO_DE_HEADER_AUTH
```

Reinicia solo la API CernoIA:

```bash
pm2 restart cernoia-api --update-env
```

## 9. Pruebas de aceptación

### Control de cuota

1. Ejecuta WF-020 manualmente con modelo `models/gemini-3.1-flash-lite`.
2. Confirma que devuelve `quota_granted: true`.
3. Comprueba en PostgreSQL:

```sql
SELECT workflow_code, outcome, minute_used, minute_limit, daily_used, daily_limit, created_at
FROM ops.ai_quota_events
ORDER BY created_at DESC
LIMIT 20;
```

4. Verifica que Redis solo escuche en localhost.

### Documentos y alertas

1. En CernoIA abre **Documentos → Cargar documento**.
2. Carga un PDF con texto y deja vacía la fecha si quieres probar la extracción.
3. Confirma en n8n que WF-011 llamó a WF-020 antes de Gemini.
4. Revisa la fecha sugerida y el tipo de proponente en **Configuración → Perfil IA**.
5. Ejecuta WF-021 manualmente una vez.
6. Abre **Alertas** y comprueba las acciones marcar leída/descartar y el resumen.

### Propuesta y firma

1. Abre una oportunidad con requisitos.
2. Entra en **Preparar propuesta**.
3. Dibuja o carga una firma PNG/JPG y acepta el consentimiento.
4. Marca la autorización específica para ese paquete.
5. Pulsa **Generar paquete de propuesta**.
6. Espera el estado `Listo` y descarga el PDF.
7. Comprueba que el PDF tenga marca de borrador, matriz, trazabilidad y, si se autorizó, la firma.
8. Confirma que otro usuario u otra organización no puede descargar ese paquete ni la firma.

## 10. Alcance jurídico y funcional de la firma

El mecanismo incorporado es una **firma electrónica simple**: imagen dibujada/cargada, consentimiento explícito, usuario autenticado, fecha, huella SHA-256 y auditoría por paquete. No se denomina ni se presenta como firma digital certificada.

Si un pliego exige certificado digital, firma emitida por una entidad de certificación, autenticación notarial o una formalidad particular, debe integrarse un proveedor acreditado y usar el mecanismo exigido. La aplicación no debe intentar simular esa certificación.

## 11. Límites deliberados

- El PDF generado es un paquete preliminar y nunca presenta automáticamente la oferta en SECOP.
- No completa de forma fiable cualquier plantilla arbitraria de la entidad. Los formatos oficiales deben mapearse y revisarse; el PDF enumera cuáles siguen pendientes.
- PDF escaneado, imágenes, Word o Excel pueden necesitar OCR/conversión adicional para extraer fechas.
- Redis limita solicitudes; no puede garantizar que Google no cambie o aplique cuotas adicionales por tokens u otros criterios.
- La activación en el VPS y la prueba contra datos reales siguen siendo obligatorias antes de compartir el servicio con clientes.
