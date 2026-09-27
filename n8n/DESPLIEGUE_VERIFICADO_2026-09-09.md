# Migración verificada de CernoIA — 9 de septiembre de 2026

Frontend: https://cernoia.secretbloom.tech

n8n: https://n8n.secretbloom.tech

La integración utiliza Frontend → API Express `/api/` → webhooks privados de n8n. Las credenciales permanecen en el servidor.

## Resultado

- 23 workflows `[CernoIA PROD]` importados con IDs propios; 22 publicados.
- WF-000 permanece inactivo: es un inicializador y no debe ejecutarse sobre la base ya instalada.
- 18 workflows anteriores de CernoIA conservados como `[RESPALDO 2026-09-09]`, inactivos.
- Los 16 workflows ajenos a CernoIA conservan exactamente nombre, estado, nodos, conexiones y configuración del respaldo anterior.
- Total: 57 workflows en la misma instancia.
- Actualización de mercado WF-019: horario original, cada hora en el minuto 23, zona America/Bogota.
- Alertas documentales WF-021: diariamente a las 07:00, zona America/Bogota.
- WF-025 y WF-026 publicados con entrada interna y manual; sus horarios siguen deshabilitados hasta configurar y aceptar notificaciones y Bold. No se enviaron mensajes ni se hicieron cobros de prueba.

## Recuperación y recursos

PM2 supervisa directamente `node_modules/n8n/bin/n8n`, con el usuario `secretbloom-n8n`. El antiguo app.js lanzaba un proceso hijo sin propagar su salida a PM2.

La unidad `/etc/systemd/system/pm2-secretbloom-n8n.service` está activa y habilitada al arrancar. Su configuración está en `/home/secretbloom-n8n/ecosystem.config.cjs`.

- Heap principal: 1024 MiB; proceso de código: 256 MiB.
- Dos ejecuciones de producción simultáneas; un trabajo de código a la vez.
- Memoria máxima de la unidad: 1800 MiB; umbral de reinicio PM2: 1200 MiB para el proceso principal.
- Reinicio automático con espera progresiva.
- Prueba controlada, sin workflows activos: SIGTERM al proceso n8n, recuperación automática y salud pública HTTP 200 en aproximadamente 18 segundos.

WF-001/002/003 quedan limitados a tres lotes por ejecución. WF-008 procesa como máximo cinco análisis y puede recuperar reclamaciones interrumpidas después de 15 minutos, hasta tres intentos. WF-014 toma como máximo dos documentos. Los cursores conservan el avance para las siguientes ejecuciones.

## Correcciones de integración

- Credenciales dedicadas de PostgreSQL, Redis y Header Auth, sin cambiar las credenciales originales.
- Clave de inventario en la API con permisos de lectura/listado. La clave temporal de migración fue revocada.
- Referencias internas y manifiesto actualizados a los IDs de producción.
- WF-011 valida rutas documentales exactas sin usar `URL`, que no está disponible en el entorno de código instalado.
- WF-021 devuelve éxito explícito cuando no hay alertas y evita consumir IA en ese caso.
- Migración `backend/sql/010_document_extraction_status.sql`: conserva estados anteriores y admite `extracted` y `needs_review`. Se aplicó con el propietario PostgreSQL; el usuario de la API no tiene permisos para alterar esa tabla.
- La auditoría obtiene el ID de WF-020 desde el workflow exportado, en lugar de un ID antiguo fijo.

Los archivos de `n8n/workflows/` reflejan lo desplegado y se guardan inactivos para futuras importaciones seguras. Las URL de WF-005/014/015 no son necesarias: son etapas internas invocadas por WF-019.

## Verificación realizada

- Auditoría de los 23 archivos: aprobada, sin advertencias.
- Readiness del backend: aprobada; PostgreSQL, Redis, ClamAV y los 22 workflows publicados reconocidos.
- Ruta autenticada del frontend: `can_start: true`, 12 etapas reconocidas y actualización aceptada con HTTP 202.
- Ejecución WF-019 número 9228: éxito, las 12 etapas recorridas y último nodo `Liberar bloqueo WF-019`.
- Ejecución WF-008 número 9234: finalizó después de cinco reservas de cuota; los fallos individuales de análisis se gestionan sin detener todo el pipeline.
- Chat: respuesta real de Gemini a través del servicio de la API y Redis.
- WF-024 número 9230: PDF sintético extraído, antivirus limpio y revisión humana pendiente.
- WF-011 número 9244: validación documental ejecutada correctamente tras la corrección.
- Propuesta: borrador sin firma generado con estado ready.
- WF-021: caso sin alertas probado, HTTP 200. La entrada temporal de prueba fue retirada.
- Los cinco webhooks públicos rechazan llamadas sin autenticación con HTTP 403.
- Artefactos sintéticos y sesiones temporales retirados. Se conservan registros de auditoría de las pruebas, errores corregidos y ejecuciones canceladas deliberadamente.

Estas pruebas no equivalen a validar todas las variantes de documentos, todas las respuestas de IA ni los proveedores que aún no tienen credenciales.

## WordPress y servicios compartidos

No se modificaron configuraciones de Nginx ni archivos WordPress, y no se reiniciaron sus servicios.

Comprobación final: CernoIA, su API y n8n responden HTTP 200. Energeticanika, Colombiashoping y Jacmelenas responden HTTP 200. Secretbloom.tech continúa con el HTTP 500 detectado antes de la migración, asociado en sus logs al plugin Gutenberg; ese problema permanece pendiente por separado.

## Pendientes externos

- Configurar credenciales de Bold y aceptar su integración antes de habilitar la conciliación programada.
- Configurar y verificar SMTP/WhatsApp y autorizar los envíos antes de habilitar WF-025.
- Revisar el error de Gutenberg en secretbloom.tech como tarea independiente.

Los respaldos privados de SQLite, configuración y PostgreSQL se encuentran en `/root/cernoia-migration-20260909-010910/`. No contienen información para compartir públicamente. No se ejecutó una restauración de prueba; el respaldo SQLite pasó la comprobación de integridad y pg_dumpall terminó correctamente.

Comprobación básica de operación:

```bash
systemctl show pm2-secretbloom-n8n --property=ActiveState,SubState,NRestarts
curl -fsS https://n8n.secretbloom.tech/healthz
```
