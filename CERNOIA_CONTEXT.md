# CernoIA — contexto técnico compacto

Actualizado: 2026-09-27 UTC. Esta memoria orienta tareas localizadas; consultar el código y la documentación detallada sólo cuando la tarea lo requiera. No contiene secretos.

## Arquitectura y repositorio

- Producción: `https://cernoia.energeticanika.com`; el árbol de aplicación conserva la ruta histórica `/home/cernoiaapp/htdocs/cernoia.secretbloom.tech`.
- Navegador → Nginx/CloudPanel → frontend React/Vinext en `127.0.0.1:3000`; `/api/*` → Express en `127.0.0.1:4001`.
- PostgreSQL es la fuente de verdad. Redis y n8n son servicios auxiliares; no sustituyen reglas, permisos ni transacciones de la API.
- Repositorio Git: `origin` usa SSH hacia `Victor-Camargo-A/Cernoia`, rama `main`. Ejecutar Git como `cernoiaapp` y empezar por `git status --short`.
- `.gitignore` excluye `.env`, runtime, dependencias, builds y copias históricas. No versionar secretos, documentos cargados, logs ni archivos generados.

## Frontend

- Código principal: `app/`, `app/components/`, `components/` y `lib/`.
- Áreas públicas: inicio, acceso, artículos, capacidades, planes, preguntas frecuentes y políticas.
- Áreas autenticadas: panel de oportunidades, documentos, alertas, propuesta/formatos, chat, facturación, equipo, configuración y automatizaciones.
- Consola global independiente: `/platform`; no reutiliza identidad de una organización cliente.
- Antes de modificar UI: localizar ruta, componente y API concreta. Probar sólo la vista, interacción y responsive afectados.

## Backend y autorización

- API Express: `backend/src/server.js`; rutas en `backend/src/routes/`; reglas de negocio en `backend/src/services/`; middleware en `backend/src/middleware/`.
- Sesión: JWT en cookie `HttpOnly`, `Secure`, `SameSite=Strict`; CSRF, validación de origen, sesiones revocables y bloqueo de intentos.
- Roles de organización: `owner`, `admin`, `analyst` y `viewer/consulta`; validar rol y `organization_id` en cada ruta.
- Plataforma: administradores y sesiones separados de los usuarios de organización. No existe selector de organización para una misma persona.
- Seguridad adicional: MFA TOTP, recuperación, invitaciones de un solo uso, auditoría de acciones sensibles y RLS de defensa en profundidad. RLS no reemplaza filtros explícitos por organización.

## PostgreSQL

- Base: `secop_ai`; esquemas funcionales: `secop` (fuentes y oportunidades), `saas` (organizaciones, usuarios, documentos, suscripciones y producto) y `ops` (ejecuciones, cuotas, alertas y operación).
- Entidades/tablas principales: organizaciones y usuarios/sesiones SaaS; oportunidades, documentos fuente y requisitos SECOP; documentos empresariales, políticas/vigencias, alertas, plantillas, paquetes y firmas; campañas/notificaciones; suscripciones y eventos Bold; auditoría, ejecuciones de workflow y cuota IA.
- Migraciones versionadas: `backend/sql/000_*.sql` en adelante; ejecutarlas sólo cuando la tarea lo requiera, tras comprobar estado y respaldo. No hacer consultas masivas ni migraciones de producción por defecto.
- Aislamiento: toda lectura/escritura de tenant debe mantener `organization_id` y usar transacción cuando el contexto RLS lo requiera.

## Documentos, requisitos y propuestas

- Carga privada de PDF, DOCX, XLSX e imágenes: validación de extensión/firma, tamaño y duplicado; antivirus; cifrado AES-256-GCM; almacenamiento fuera del directorio público.
- Extracción/OCR termina en resultado o revisión humana; no asumir fechas, tipo documental ni afirmaciones sin evidencia.
- Políticas de vigencia, alertas y faltantes se basan en reglas deterministas. IA sólo puede sugerir y resumir dentro de límites.
- Plantillas DOCX con marcadores y PDF con campos se versionan. El autollenado usa datos confirmados; valores sin soporte quedan para revisión.
- Paquete de propuesta es un borrador descargable, no presenta ofertas en SECOP. La firma implementada es electrónica simple (consentimiento, huella SHA-256 y auditoría), no firma digital certificada.

## n8n, Redis y Gemini

- n8n local: `https://n8n.secretbloom.tech`, interno `127.0.0.1:5678`; no inspeccionar todos los workflows. Localizar siempre por nombre/ID y revisar sólo input, output y ejecución relevante.
- Fuentes versionadas de workflows: `n8n/workflows/`; manifiesto: `n8n/workflow-manifest.json`. El paquete histórico contiene WF-000…WF-026; producción además opera flujos posteriores como WF-031/032. Inventario operativo sin secretos: `/root/docs/N8N_WORKFLOWS_INVENTORY_2026-09-27.md`.
- WF-019 orquesta el pipeline SECOP; WF-007 maneja errores; WF-011 documentos; WF-020 controla cuota Gemini con Redis; WF-021 alertas; WF-022 propuestas; WF-023 chat; WF-024 OCR; WF-025 notificaciones; WF-026 renovaciones; WF-031/032 campañas del dueño.
- Redis local controla reservas atómicas RPM/RPD compartidas; PostgreSQL conserva auditoría. No exponer Redis ni usarlo como fuente de verdad.
- Gemini recibe sólo contexto reducido, permitido y anonimizado. Nunca enviar HTML, logs, documentos completos, secretos ni datos de otra organización. Mantener fallback determinista cuando no haya cuota o falle el proveedor.

## Pagos, notificaciones y almacenamiento externo

- Bold: enlaces de pago; el webhook firmado e idempotente es la única fuente que habilita suscripción. Una redirección del navegador nunca activa servicios.
- Fundadores: reserva transaccional de 100 cupos; plan fundador y plan empresarial están modelados en backend. Probar sandbox/aprobación/rechazo/duplicado antes de cambios de facturación.
- Correo/WhatsApp: bandeja durable, reintentos limitados y DLQ. No cambiar proveedores ni credenciales salvo tarea explícita.
- ClamAV/Poppler/OCR son dependencias de procesamiento; verificar sólo el flujo afectado cuando se trabaje en documentos.

## Rutas y puntos de entrada frecuentes

- Salud: `GET /api/health`.
- API de cuenta/autenticación: `backend/src/routes/auth.js` y `account.js`.
- Oportunidades y datos: `data.js`, `bids.js`, `market.js`, `operations.js`.
- Documentos y previews: `documents.js`, `document-previews.js`, `templates.js`.
- Propuestas: `proposals.js` y `opportunity-preparation.js`.
- Integraciones: `workflows.js`, `chat.js`, `notifications.js`, `billing.js`, `campaigns.js`.
- No enumerar endpoints completos para una tarea: buscar primero la ruta o símbolo solicitado.

## Despliegue y operación

- PM2 de CernoIA, usuario `cernoiaapp`: `cernoia-api`, `cernoia-frontend`, `cernoia-company-matrix`, `cernoia-document-metadata`, `cernoia-public-matrix` y `cernoia-search-refresh`. Los procesos `*-standby` detenidos no se eliminan sin análisis.
- Configuración PM2: `deploy/ecosystem.config.cjs`. No ejecutar instalación, build, migración, reload ni restart para una modificación pequeña sin necesidad directa.
- Logs CernoIA: `/home/cernoiaapp/.pm2/logs/`; logs n8n: `/home/secretbloom-n8n/.pm2/logs/`; Nginx/sistema: `/var/log/nginx/` y journal. Usar filtros y líneas limitadas.
- La configuración privada está fuera de Git. No imprimir `.env`, claves SSH, tokens, credenciales de PostgreSQL, Redis, Gemini, Bold o n8n.
- Backups/restauración: scripts `deploy/backup-cernoia.sh` y `restore-cernoia.sh`; restaurar sólo en base/entorno de ensayo y con respaldo previo.

## Convenciones de trabajo

- Localizar → leer lo mínimo → entender → modificar lo mínimo → probar lo afectado → documentar.
- Excluir de búsquedas globales `node_modules`, `.next`, `dist`, `build`, backups, logs y directorios generados.
- Antes y después de cambios: `git status --short`; revisar sólo `git diff -- ARCHIVO` y no sobrescribir trabajo ajeno.
- Pruebas por capas: test específico, luego módulo; build/suite completa sólo si el cambio lo justifica.
- No desplegar desde Git ni tocar DNS, SSL, pagos, credenciales o datos productivos sin petición explícita.

## Funcionalidad implementada

- Autenticación y aislamiento multi-tenant; consola de plataforma; onboarding y equipo.
- Oportunidades SECOP, búsqueda/filtros/favoritos, matriz y preparación de propuesta.
- Expediente documental, vigencias, alertas, OCR/revisión y plantillas/firma simple.
- Chat controlado, cuota compartida de Gemini/Redis y automatización n8n.
- Mapa territorial, facturación Bold, notificaciones y campañas del dueño.
- Git remoto de producción conectado el 2026-09-27; no implica despliegue automático.

## Pendientes importantes

- Demo de oportunidades/formatos: decisión funcional confirmada: el análisis y la lista de formatos se ven sin suscripción; el cierre/modal de suscripción debe aparecer sólo después de generar y mostrar los formatos diligenciados.
- El ZIP de formatos reportado contiene 13 archivos (incluye carta de presentación, experiencia, seguridad social y oferta económica). Deben mostrarse en Requisitos incluso antes de asociación automática.
- Trabajo previo de demo: se reportó la aplicación de `20260923_demo_result_gate.sql` y la recuperación de un análisis. La edición de UI quedó incompleta; verificar el estado real antes de continuar y probar únicamente flujo demo, reintentos y gate de suscripción.
- Antes de ampliar clientes/pagos: validar de forma dirigida Bold, proveedores de notificación, cuota real Gemini, OCR/antivirus, dos organizaciones aisladas, backup/restauración y credenciales/workflows n8n relevantes.
- Mantener las discrepancias históricas de documentación (dominios anteriores y paquete de 23 workflows) como referencia, no como estado operativo actual.
