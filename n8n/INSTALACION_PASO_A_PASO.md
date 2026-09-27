# Instalar los workflows de CernoIA paso a paso

Esta guía está escrita para la instancia existente en `https://n8n.secretbloom.tech`. No instala Docker, no reemplaza Nginx y no modifica ningún sitio WordPress.

## Antes de tocar n8n

1. Conserva el ZIP anterior del proyecto.
2. Haz un respaldo de PostgreSQL desde CloudPanel o con el método que ya uses.
3. En n8n, exporta una copia de los workflows actuales.
4. No borres workflows ni credenciales. Primero desactiva y renombra las versiones anteriores con el prefijo `[RESPALDO]`.

Los comandos de esta guía marcados como **VPS — Linux** se ejecutan en la terminal de Hostinger/CloudPanel. No se escriben en `C:\Users\...`.

## 1. Aplicar la base de datos

Primero instala la aplicación siguiendo `docs/DESPLIEGUE_CLOUDPANEL_AGENTGLOBAL.md`. Dentro de la carpeta del proyecto y como Site User, el instalador ejecuta las nueve migraciones `000` a `008`. También puedes comprobarlo así:

```bash
npm --prefix backend run migrate
```

No ejecutes además WF-000 si el comando anterior terminó correctamente: ambos aplican el mismo esquema. WF-000 queda como alternativa manual y nunca debe publicarse ni programarse.

## 2. Preparar Redis y el secreto compartido

Antes de importar, completa la instalación local y segura de Redis descrita en `docs/FASE_2_REDIS_ALERTAS_PROPUESTAS.md`. Redis debe escuchar únicamente en localhost y responder con contraseña.

En `backend/.env` ya debes tener un valor privado en `N8N_WEBHOOK_SECRET`.

En n8n abre **Credentials → Add credential → Header Auth** y crea:

| Campo | Valor |
|---|---|
| Nombre | `CernoIA Webhook Secret` |
| Header Name | `Authorization` |
| Header Value | `Bearer EL_MISMO_VALOR_DE_N8N_WEBHOOK_SECRET` |

Debe existir un espacio entre `Bearer` y el secreto. No pegues el secreto en el frontend ni lo envíes por chat.

## 3. Importar los 23 archivos

Los archivos importables están exclusivamente en `n8n/workflows/`. `n8n/workflow-manifest.json` es informativo y no se importa.

### Método visual recomendado

1. Descomprime el ZIP en tu computador.
2. Entra a `https://n8n.secretbloom.tech`.
3. En el menú de workflows elige **Import from File**.
4. Importa cada JSON de `n8n/workflows/`.
5. Confirma que el nombre de cada nuevo flujo comienza con `[CernoIA PROD]`.
6. Déjalos sin publicar hasta terminar las credenciales y enlaces.

La carpeta debe producir 23 workflows, de WF-000 a WF-026 con los saltos documentados.

### Método CLI opcional

Úsalo solo después de identificar el mismo usuario Linux y la misma configuración con que se ejecuta n8n. La CLI oficial permite importar todos los JSON de una carpeta y sobrescribe registros que tienen el mismo ID. No ejecutes este comando como `root` si n8n corre con otro usuario.

```bash
n8n import:workflow --separate --input=/RUTA/DEL/PROYECTO/n8n/workflows/
```

Si `command -v n8n` no devuelve una ruta, detente y usa el método visual.

## 4. Revisar credenciales de nodos

Abre cada workflow `[CernoIA PROD]` y confirma que no haya triángulos rojos.

- Todos los nodos PostgreSQL: selecciona la credencial real de la base CernoIA.
- WF-008, WF-011, WF-015, WF-021, WF-022 y WF-023: selecciona la credencial real de Google Gemini usada actualmente.
- WF-020: selecciona `CernoIA Redis` en sus dos nodos Redis.
- WF-019, nodo `Webhook seguro CernoIA WF-019`: selecciona `CernoIA Webhook Secret`.
- WF-011, nodos `Webhook seguro…` y `Descargar documento privado…`: selecciona `CernoIA Webhook Secret`.
- WF-022, nodos `Webhook seguro…` y `Renderizar PDF privado…`: selecciona `CernoIA Webhook Secret`.
- WF-023, nodo `Webhook seguro…`: selecciona `CernoIA Webhook Secret`.
- WF-024, nodos `Webhook seguro…` y `Ejecutar OCR privado…`: selecciona `CernoIA Webhook Secret`.

No edites manualmente las consultas SQL ni cambies `organization_id`.

## 5. Reconectar los subworkflows si usaste importación visual

La interfaz de n8n puede asignar IDs nuevos al importar. Por eso abre `[CernoIA PROD] WF-019` y, en cada nodo `Ejecutar WF-…`, vuelve a seleccionar desde el desplegable la versión que comienza con `[CernoIA PROD]`:

1. WF-001
2. WF-002
3. WF-003
4. WF-005
5. WF-008
6. WF-013
7. WF-014
8. WF-015
9. WF-016
10. WF-012
11. WF-017
12. WF-018

Vuelve a seleccionar `[CernoIA PROD] WF-020` dentro de WF-008, WF-011, WF-015, WF-021, WF-022 y WF-023. En **Settings** de los workflows de producción, selecciona `[CernoIA PROD] WF-007` como **Error workflow** si n8n indica que la referencia importada no existe.

## 6. Publicar en orden

Publica o activa, según el texto que muestre tu versión de n8n, en este orden:

1. WF-007
2. WF-020
3. WF-001, WF-002, WF-003
4. WF-005, WF-008
5. WF-011
6. WF-012, WF-013, WF-014, WF-015, WF-016, WF-017, WF-018
7. WF-021, WF-022, WF-023, WF-024
8. WF-025, WF-026
9. WF-019 al final

WF-000 permanece inactivo. Las etapas internas no contienen horarios independientes; el único horario coordinador está en WF-019. Si solo quieres ejecución manual desde la aplicación, deshabilita el nodo `Schedule Trigger` de WF-019 antes de publicarlo.

## 7. Copiar las URL de producción

Al publicar WF-019, WF-011, WF-022, WF-023 y WF-024, n8n registra estas rutas de producción:

```text
https://n8n.secretbloom.tech/webhook/cernoia/wf-019
https://n8n.secretbloom.tech/webhook/cernoia/wf-011
https://n8n.secretbloom.tech/webhook/cernoia/wf-022
https://n8n.secretbloom.tech/webhook/cernoia/wf-023
https://n8n.secretbloom.tech/webhook/cernoia/wf-024
```

En `backend/.env` deben coincidir:

```dotenv
N8N_WF019_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-019
N8N_WF011_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-011
N8N_WF022_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-022
N8N_WF023_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-023
N8N_WF024_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-024
N8N_TIMEOUT_MS=15000
```

Después reinicia solo la API CernoIA:

```bash
pm2 restart cernoia-api --update-env
```

## 8. Crear una API key de verificación

En n8n abre la configuración de API, crea una clave y colócala únicamente en:

```dotenv
N8N_API_KEY=TU_CLAVE_PRIVADA
```

La API de CernoIA la usa para leer nombre/estado de los workflows; nunca la entrega al navegador. Reinicia nuevamente `cernoia-api` después de guardarla.

## 9. Comprobar antes de procesar

En el VPS, como Site User y dentro del proyecto:

```bash
npm --prefix backend run readiness
```

Debe terminar con:

```text
RESULTADO: CernoIA está lista para iniciar el pipeline.
```

Si dice `FALTA`, `SIN PUBLICAR` o `NO VERIFICADO`, no pulses todavía **Iniciar actualización**. Corrige exactamente el elemento indicado.

## 10. Preparar la empresa desde el frontend

1. Entra a `https://agentglobal.online`.
2. Ve a **Configuración → Perfil IA**.
3. Confirma el tipo de proponente, la identidad empresarial, capacidades demostrables y un perfil de búsqueda activo.
4. Ve a **Documentos → Cargar documento** y carga primero Cámara de Comercio, RUT y certificados relevantes.
5. Ve a **Automatización**. Debes ver 12/12 etapas y los workflows de soporte listos.
6. Pulsa **Iniciar actualización** una sola vez.
7. En una oportunidad abre **Preparar propuesta** para probar generación, firma opcional y descarga.

## 11. Resultado esperado

En n8n debe aparecer una ejecución WF-019 y, dentro de ella, las doce etapas en orden. En CernoIA deben aparecer:

- una ejecución en el historial asociada a la organización;
- procesos sincronizados;
- coincidencias creadas por los perfiles activos;
- análisis de IA para más de una oportunidad cuando existan candidatas;
- documentos y requisitos procesados;
- evaluación de cumplimiento y plan de acción.
- alertas documentales materializadas y un resumen diario cuando esté habilitado;
- paquete preliminar de propuesta descargable desde la oportunidad.
- conversaciones privadas de Chat CernoIA con fuentes;
- OCR/revisión con estado terminal;
- notificaciones entregadas o visibles en la DLQ;
- conciliación mensual ejecutable desde WF-026.

Los PDF empresariales con texto, DOCX y XLSX compatibles se extraen automáticamente. PDF escaneado e imágenes pasan por OCR dentro de límites; cualquier formato, baja confianza o fallo termina como **requiere revisión**, nunca indefinidamente en “procesando”.

## Si algo falla

Recoge estas salidas sin mostrar secretos:

```bash
npm --prefix backend run readiness
pm2 status
pm2 logs cernoia-api --lines 80
curl https://n8n.secretbloom.tech/healthz
```

En n8n abre la ejecución fallida y anota únicamente el nombre del nodo rojo y el mensaje de error. No compartas credenciales, cabeceras Authorization ni el archivo `backend/.env`.
