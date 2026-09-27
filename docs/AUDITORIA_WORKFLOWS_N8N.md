# Auditoría de los workflows n8n de CernoIA

Fecha: 7 de septiembre de 2026  
Material: 14 exportaciones originales, frontend, API, migraciones y 9 workflows agregados.

## Dictamen

La colección original no constituía un pipeline completo: WF-008 seleccionaba una sola fila y WF-019 estaba inactivo, sin webhook y con etapas ausentes. El paquete actual contiene **23 workflows** con contratos de tenant, control de errores, cuota, documentos, propuestas, chat, OCR, notificaciones y facturación.

Todos se entregan con el prefijo `[CernoIA PROD]` e inactivos. Importar un JSON no equivale a publicarlo ni garantiza que las credenciales de la instancia sean correctas.

## Correcciones comprobadas

| Severidad | Hallazgo | Corrección |
|---|---|---|
| Crítica | WF-008 usaba `LIMIT 1` sin volver a la cola | Bucle completo, pausa, resultado y salida al vaciarse |
| Crítica | WF-019 no tenía entrada para la aplicación | Webhook Header Auth y respuesta inmediata |
| Crítica | WF-019 omitía etapas | Orquestación secuencial de 12 etapas |
| Crítica | WF-016 no existía | Consolidación implementada con contrato estable |
| Crítica | WF-011 no existía | Procesamiento empresarial y revisión implementados |
| Alta | Expresiones `=={{` y campos inválidos | Expresiones y nombres normalizados |
| Alta | Se perdía `organization_id` | Propagación explícita en pipeline y soportes |
| Alta | Cero filas podía cortar la cadena | Salida garantizada sin ocultar fallos |
| Alta | Horarios duplicados | Solo los coordinadores/trabajadores conservan Schedule Trigger |
| Alta | WF-000 mezclaba datos piloto y acciones manuales | Migración idempotente sin datos personales |
| Alta | WF-014 dependía de comandos/rutas locales | Extracción segura y revisión para formatos no resueltos |
| Alta | SQL final de WF-019 contenía caracteres de parche | Consulta corregida y regla preventiva |
| Alta | 24 nodos heredados interpolaban SQL | Parametrizados con `$1…$n` y `queryReplacement` |
| Crítica | Gemini carecía de límite global | WF-020 con Redis, TTL, espera/denegación y auditoría |
| Alta | No había agenda de alertas | WF-021 materializa reglas y resumen con fallback |
| Alta | No existía artefacto descargable | WF-022 coordina el paquete preliminar |
| Alta | No había asistente conversacional controlado | WF-023 con una iteración, contexto acotado y citas |
| Alta | OCR podía quedar indefinidamente procesando | WF-024 y API terminan en éxito o revisión |
| Alta | No había entrega durable de avisos | WF-025 procesa bandeja, reintentos y DLQ |
| Alta | No había renovación/conciliación de suscripción | WF-026 coordina la ruta interna de facturación |

## Pipeline de producción

| Orden | Workflow | Resultado |
|---:|---|---|
| 1 | WF-001 | Sincronización incremental SECOP |
| 2 | WF-002 | Versiones y cambios |
| 3 | WF-003 | Metadatos de documentos públicos |
| 4 | WF-005 | Coincidencias con perfiles empresariales |
| 5 | WF-008 | Preanálisis IA de toda la cola elegible |
| 6 | WF-013 | Selección documental |
| 7 | WF-014 | Extracción de documentos de oportunidad |
| 8 | WF-015 | Requisitos mediante IA |
| 9 | WF-016 | Matriz consolidada |
| 10 | WF-012 | Vigencias empresariales |
| 11 | WF-017 | Evaluación de cumplimiento |
| 12 | WF-018 | Faltantes y plan de acción |

WF-019 coordina esa secuencia. WF-007 maneja errores. WF-011 y WF-020 a WF-026 atienden servicios de producto/operación.

## Reglas verificadas automáticamente

`npm run audit:workflows` comprueba:

- los 23 códigos y el manifiesto;
- JSON, IDs, nombres y conexiones;
- ausencia de `Execute Command`, datos piloto y expresiones dañadas;
- webhooks autenticados y contratos con `organization_id`;
- orden/continuidad de WF-019;
- bucle completo de WF-008;
- parámetros SQL en las consultas endurecidas;
- Redis y control previo de los agentes Gemini;
- una iteración y reintentos acotados;
- fallbacks de alertas/propuestas;
- callbacks privados de OCR y renderizado;
- trabajadores de notificación/facturación.

Resultado local: **23 workflows aprobados, 0 fallos y 0 advertencias**.

## Límites de la auditoría

Esta auditoría valida estructura y contratos estáticos. No ejecuta consultas contra el PostgreSQL real, Redis, Gemini ni `n8n.secretbloom.tech`, porque el entorno local no contiene esas credenciales.

La certificación final exige:

1. aplicar migraciones `000` a `008` sobre respaldo;
2. importar las exportaciones;
3. reconectar cada credencial/subworkflow;
4. publicar según `n8n/workflow-manifest.json`;
5. ejecutar una oportunidad real y dos tenants de prueba;
6. probar cuota agotada, OCR/revisión, alertas, propuesta, chat y conciliación;
7. revisar historial, reintentos y DLQ.

Hasta completar esos pasos, el estado correcto es “código preparado”, no “producción certificada”.
