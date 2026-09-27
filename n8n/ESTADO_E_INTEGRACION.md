> Actualización del 9 de septiembre de 2026: la migración ya fue realizada. Consulta [el despliegue verificado](DESPLIEGUE_VERIFICADO_2026-09-09.md) para el estado vigente, las pruebas y los pendientes. El contenido siguiente corresponde al corte anterior.

# Estado real de workflows e integración

Fecha de corte: 7 de septiembre de 2026.

El repositorio contiene **23 exportaciones n8n**. Todas llegan inactivas para impedir ejecuciones y horarios duplicados durante la importación. El código local pasó la auditoría estructural, pero ningún workflow se considera activo en `n8n.secretbloom.tech` hasta importarlo, reconectar credenciales, publicarlo y probarlo allí.

## Mapa funcional

| Función | Workflow(s) | Estado del código |
|---|---|---|
| Inicialización idempotente | WF-000 | Incluido; debe permanecer inactivo |
| Pipeline de inteligencia de mercado | WF-001/002/003/005/008/013/014/015/016/012/017/018 | 12 etapas incluidas |
| Manejo global de errores | WF-007 | Incluido |
| Expediente documental empresarial | WF-011 | Webhook y revisión incluidos |
| Orquestación principal | WF-019 | Webhook y cadena de 12 etapas incluidos |
| Control compartido de Gemini | WF-020 | Redis RPM/RPD y auditoría incluidos |
| Alertas documentales | WF-021 | Reglas y resumen con fallback incluidos |
| Paquete de propuesta | WF-022 | Solicitud y callback privado incluidos |
| Chat CernoIA | WF-023 | Agente controlado y citado incluido |
| OCR y revisión | WF-024 | Webhook de procesamiento incluido |
| Entrega de notificaciones | WF-025 | Worker programado incluido |
| Renovaciones Bold | WF-026 | Conciliación y recordatorios incluidos |

## Pipeline principal

WF-019 ejecuta, en orden:

1. WF-001 — sincronización SECOP;
2. WF-002 — historial de cambios;
3. WF-003 — metadatos documentales;
4. WF-005 — coincidencias empresariales;
5. WF-008 — preanálisis de IA con bucle completo;
6. WF-013 — selección documental;
7. WF-014 — extracción de documentos públicos;
8. WF-015 — extracción de requisitos;
9. WF-016 — consolidación;
10. WF-012 — vigencias empresariales;
11. WF-017 — cumplimiento;
12. WF-018 — plan de acción.

La API solo permite al cliente iniciar WF-019. Los demás flujos son servicios internos o programados y no aparecen como botones técnicos.

## Servicios de soporte

### WF-020 — Gemini y Redis

- lee la política de `ops.ai_quota_policies`;
- reserva cupos por minuto y día mediante contadores atómicos y TTL;
- espera ante límite por minuto y deniega ante límite diario;
- registra cada decisión en PostgreSQL;
- devuelve intacto el payload al workflow llamador.

WF-008, WF-011, WF-015, WF-021, WF-022 y WF-023 deben pasar por WF-020. Los valores iniciales de 8 RPM y 400 RPD son conservadores y deben ajustarse a la cuota que muestre el proyecto real de Google AI Studio.

### WF-021 y WF-025 — alertas

WF-021 materializa alertas de vencimiento, expiración, fecha faltante y revisión. La existencia de la alerta no depende de IA; Gemini solo redacta el resumen y existe un fallback determinístico. WF-025 entrega la bandeja por canales activos/verificados y conserva reintentos y fallos terminales.

### WF-022 — propuesta

Solicita datos de la empresa, oportunidad, requisitos y evidencias del tenant correcto. Puede usar IA previa reserva de cuota y llama a la API privada para renderizar un PDF. La salida es un borrador revisable; la firma electrónica simple solo se aplica con consentimiento y confirmación específica.

### WF-023 — Chat CernoIA

Recibe mensajes exclusivamente desde la API, conserva `organization_id`, obtiene contexto parametrizado, reserva cuota en WF-020 y limita el agente a una iteración. La respuesta exige fuentes/citas y no expone herramientas generales, secretos ni SQL arbitrario.

### WF-024 — OCR y revisión

Coordina el procesamiento documental con la API privada. Un fallo, documento sin texto, formato que necesita conversión o baja confianza termina en `review_required`; no deja archivos indefinidamente en procesamiento.

### WF-026 — Bold

Llama a la conciliación interna para reintentar eventos persistidos, expirar enlaces, cambiar suscripciones a mora/expirada y crear recordatorios mensuales. El webhook firmado de la API sigue siendo la fuente primaria de confirmación de pago.

## Auditoría automatizada

`npm run audit:workflows` valida:

- presencia de las 23 exportaciones y manifiesto coherente;
- JSON, IDs, conexiones y destinos internos;
- ausencia de `Execute Command`, datos piloto y expresiones rotas;
- webhooks Header Auth y contratos con `organization_id`;
- orden exacto y continuidad de las doce etapas;
- bucle de WF-008 y manejo de cero filas;
- Redis, TTL y control previo a cada agente;
- callbacks privados de propuestas/OCR;
- horarios únicos y trabajadores operativos;
- SQL heredado parametrizado.

Resultado local actual: **23 workflows, 0 fallos y 0 advertencias**. Esto prueba estructura del paquete, no ejecución contra servicios reales.

## Orden de activación

Usa exactamente `n8n/workflow-manifest.json`. Resumen:

1. importar los 23 JSON;
2. reconectar PostgreSQL, Gemini, Redis y Header Auth;
3. seleccionar nuevamente los subworkflows desde cada nodo de ejecución;
4. mantener WF-000 inactivo;
5. publicar servicios base y luego WF-019;
6. comprobar que solo los workflows programados conservan Schedule Trigger;
7. ejecutar la aceptación funcional antes de permitir usuarios.

## Dependencias externas pendientes

1. respaldo de PostgreSQL y migraciones `000` a `008`;
2. Redis local protegido y credencial `CernoIA Redis`;
3. credencial PostgreSQL, Gemini y `CernoIA Webhook Secret`;
4. URLs WF-011, WF-019, WF-022, WF-023 y WF-024 en `backend/.env`;
5. importación/publicación en la instancia real;
6. datos reales de dos organizaciones para probar aislamiento;
7. prueba de cuota, OCR, alertas, propuesta, chat y pago;
8. comprobación de logs y DLQ sin trabajos abiertos inesperados.

No se debe afirmar que los workflows están operativos en producción hasta completar esos ocho puntos.
