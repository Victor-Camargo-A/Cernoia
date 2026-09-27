# Auditoría integral de CernoIA

Fecha: 7 de septiembre de 2026  
Alcance: frontend Vinext/React, API Express, autenticación, PostgreSQL, integración con n8n y preparación para CloudPanel.

## Resultado ejecutivo

La aplicación ya cuenta con un frontend funcional y una API privada para las operaciones del usuario. La revisión inicial encontró que el panel anterior era principalmente de consulta: no permitía cargar documentos, no tenía gestión de oportunidades, mostraba códigos internos de automatización y las sesiones JWT no podían revocarse.

Durante esta intervención se cerraron los hallazgos críticos que podían resolverse desde el repositorio. También se agregaron pagos Bold, Chat CernoIA, mapa territorial, OCR/revisión, plantillas, notificaciones, MFA y recuperación operativa. La publicación real todavía depende de credenciales y pruebas en PostgreSQL, n8n, Redis, Bold, correo/WhatsApp, DNS y CloudPanel.

## Hallazgos y estado

| Prioridad | Hallazgo | Riesgo | Estado |
|---|---|---|---|
| Crítica | El historial de `ops.workflow_runs` no filtraba por empresa | Exposición cruzada entre organizaciones | Corregido: solo devuelve registros cuyo `metadata.organization_id` coincide con la sesión |
| Alta | JWT sin registro de sesiones revocables | Una cookie robada seguía válida hasta expirar | Corregido: tabla `app_sessions`, revocación, expiración y cierre global |
| Alta | Operaciones mutables protegidas solo por `SameSite`/origen | Defensa CSRF incompleta | Corregido: token CSRF de doble envío y validación de origen |
| Alta | No existía interfaz ni API de carga documental | El flujo empresarial principal no era utilizable | Corregido: formulario, validación binaria, hash, almacenamiento privado y trazabilidad |
| Crítica | Gemini no tenía un límite compartido entre workflows | Saturación de RPM/RPD y errores 429 en la capa gratuita | Corregido en código: WF-020 usa Redis y política central; pendiente activar/probar en VPS |
| Alta | No había alertas documentales persistentes ni resumen | Vencimientos podían pasar inadvertidos | Corregido: WF-021 materializa alertas, las resuelve y genera resumen con fallback |
| Alta | El análisis no producía un paquete descargable | La preparación terminaba sin artefacto para revisión | Corregido: WF-022 y API renderizan PDF privado preliminar |
| Alta | No había consentimiento ni trazabilidad para firma | Riesgo de aplicar una imagen sin autorización específica | Corregido: perfil privado, consentimiento, confirmación por paquete, hash y auditoría |
| Alta | El frontend ofrecía ejecutar subprocesos internos aislados | Estados parciales o incoherentes en n8n | Corregido: solo se permite iniciar la orquestación principal |
| Media | Sin bloqueo por intentos fallidos | Fuerza bruta sobre cuentas | Corregido: límite por IP y bloqueo temporal por cuenta |
| Media | Sin cambio de contraseña ni cierre de otras sesiones | Gestión de acceso insuficiente | Corregido |
| Media | Sin administración de equipo y roles | Onboarding dependiente de base de datos | Corregido: propietario/administrador crean y administran cuentas |
| Media | Sin estado comercial, favoritos o notas | Las oportunidades no tenían ciclo de trabajo | Corregido |
| Media | Códigos técnicos visibles al cliente | Experiencia confusa y poco alineada con marca | Corregido en la interfaz |
| Media | Archivos validados solo por extensión | Posible suplantación de formato | Corregido: firma binaria, límites, ClamAV, cifrado y estados de revisión; pendiente prueba con daemon real |
| Media | No se confirmó Row Level Security en tablas heredadas | Una cuenta SQL sobredimensionada amplía el impacto de un error | Políticas agregadas a tablas nuevas y filtros explícitos en API; tablas heredadas deben revisarse en PostgreSQL |
| Media | No existía recuperación por correo ni MFA | Recuperación dependía del administrador | Corregido en código: tokens de un solo uso, correo y MFA TOTP; pendiente conectar SMTP |
| Media | No se pudo ejecutar el inventario dentro de la instancia n8n real | No es posible certificar el pipeline de extremo a extremo | Los 23 JSON están incluidos; pendiente importación, credenciales, activación y prueba real |
| Alta | La redirección de la pasarela podía confundirse con confirmación | Acceso sin pago confirmado | Corregido: solo el webhook Bold firmado, idempotente y con monto/moneda exactos activa la suscripción |
| Alta | No había protección de los 100 cupos fundadores bajo concurrencia | Duplicación o sobreventa del cupo | Corregido: asignación transaccional, bloqueo y restricciones únicas |
| Media | No existía canal de preguntas sobre los datos | Usuarios dependían de pantallas aisladas | Corregido: Chat CernoIA con contexto limitado, citas, cuota y agente controlado |
| Media | No existía análisis geográfico navegable | Difícil comparar mercado territorial | Corregido: Colombia → departamento → municipio → pagaduría con periodo y métricas |
| Baja | Dependencias con vulnerabilidades conocidas | Riesgo en la cadena de suministro | Verificado el 7 de septiembre de 2026: `npm audit --omit=dev` reportó 0 en frontend y API usando el registro actualizado |

## Autenticación implementada

- JWT firmado con HS256, `issuer`, `audience`, `sub` y `sid` obligatorios.
- Cookie de sesión `HttpOnly`, `Secure` y `SameSite=Strict` en producción.
- Cookie CSRF legible por el cliente y cabecera `X-CSRF-Token` comparadas en tiempo constante.
- Sesiones persistidas, revocables y con última actividad.
- Límite de ocho intentos por IP cada quince minutos.
- Bloqueo de cuenta después de cinco fallos durante quince minutos.
- Contraseñas derivadas con `scrypt`, salt aleatorio y política mínima de doce caracteres con letras y números.
- Roles `owner`, `admin`, `analyst` y `viewer` aplicados en servidor, no solo en la interfaz.
- Auditoría de accesos, fallos, cambios de contraseña, usuarios, documentos, oportunidades y automatizaciones.
- Sin registro público: el alta se mantiene privada y controlada por la organización.

## Producto y frontend implementados

- Inicio con métricas, valor potencial, afinidad, cierres y salud documental.
- Búsqueda, filtros, paginación y detalle de oportunidades.
- Etapas de seguimiento, favoritos y notas privadas.
- Lectura ejecutiva de IA, requisitos y documentos fuente.
- Cobertura entre requisitos y documentos empresariales cuando existe la tabla de correspondencias.
- Repositorio documental con carga por arrastre/selector, descarga, vigencias y retiro lógico.
- Centro de alertas para fechas límite y vencimientos documentales.
- Resumen inteligente diario de documentos con salida determinística si no hay cuota de IA.
- Perfil empresarial con tipo de proponente confirmado y sugerencia basada en documentos.
- Espacio **Preparar propuesta** con paquete PDF, descarga privada y estados de procesamiento.
- Firma electrónica simple dibujada o cargada, opcional para cada paquete.
- Plantillas DOCX/PDF versionadas, autollenado controlado y descarga privada.
- Chat CernoIA con hilos privados, fuentes y límite por usuario/IA.
- Mapa de contratación por departamento, municipio y pagaduría.
- Facturación Bold, historial, 100 fundadores y renovaciones mensuales.
- Canales de correo/WhatsApp verificables y centro operativo con DLQ.
- MFA TOTP, recuperación de contraseña y políticas de revisión documental.
- Automatización expresada con lenguaje de producto, sin exponer los códigos internos.
- Preferencias de notificación y afinidad mínima.
- Administración de usuarios, roles y estados.
- Cambio de contraseña, inventario de sesiones y cierre global.
- Diseño responsive alineado con la marca: azul petróleo, turquesa y el concepto “Ver. Comprender. Anticipar.”

## Modelo de datos agregado

Las migraciones `backend/sql/002_product_frontend.sql` a `008_security_documents_templates.sql` agregan, de forma idempotente:

- controles de intentos y cambio de contraseña en `saas.app_users`;
- `saas.app_sessions`;
- `saas.app_opportunity_states`;
- `saas.app_organization_settings`;
- `saas.app_signature_profiles`, `saas.document_alerts` y `saas.alert_digests`;
- `saas.proposal_packages`;
- `saas.organizations.organization_type`;
- `ops.ai_quota_events` y `ops.ai_quota_policies`.
- planes, suscripciones, órdenes, eventos Bold y eventos de ciclo;
- hilos/mensajes de chat y agregados territoriales;
- canales, bandeja de notificaciones, entregas y trabajos muertos;
- MFA, restablecimiento, revisiones/OCR y políticas documentales;
- plantillas, versiones y documentos generados.

No se creó MongoDB. El proyecto ya usa PostgreSQL como fuente de verdad en los esquemas `secop`, `saas` y `ops`; duplicar esos datos aumentaría el riesgo de inconsistencias.

## Límites de la validación realizada

Se verificaron sintaxis, lint, compilación y pruebas unitarias. No fue posible ejecutar pruebas reales contra PostgreSQL ni n8n porque el entorno de trabajo no contiene sus credenciales. Por el mismo motivo, los endpoints que consultan las tablas heredadas deben probarse en una copia o respaldo de la base antes de abrir el dominio al público.

## Validación final del paquete

Ejecutada el 7 de septiembre de 2026 después de actualizar las dependencias:

- compilación de producción Vinext: aprobada;
- TypeScript y ESLint: aprobados sin errores;
- pruebas estructurales del frontend y límites de seguridad: 13 de 13 aprobadas;
- pruebas unitarias de la API, criptografía, Bold y renderizado: 9 de 9 aprobadas;
- auditoría n8n: 23 workflows, 0 fallos y 0 advertencias;
- sintaxis JavaScript y JSON: aprobada;
- `npm audit --omit=dev`: 0 vulnerabilidades conocidas tanto en la raíz como en la API.
- carga diferida por sección: el paquete inicial dejó de incluir mapa, gráficos y paneles no abiertos.

Las 24 interpolaciones SQL heredadas de WF-001 a WF-005 fueron convertidas a parámetros y ahora forman parte de la regla automática de auditoría.

## Pruebas de aceptación pendientes en el VPS

1. Aplicar migraciones sobre un respaldo reciente.
2. Crear el primer usuario propietario.
3. Confirmar que dos organizaciones nunca ven datos entre sí.
4. Cargar y descargar un PDF, un DOCX y una imagen válidos.
5. Verificar rechazo de archivo falso, duplicado y mayor de 20 MB.
6. Confirmar que cerrar todas las sesiones invalida los demás navegadores.
7. Ejecutar la actualización integral y comprobar su registro con `organization_id`.
8. Confirmar la cadena WF-019 → matching → documentos → requisitos.
9. Probar WF-020 bajo concurrencia y contrastar RPM/RPD con Google AI Studio.
10. Ejecutar WF-021 y verificar alertas/resumen con y sin cuota de IA.
11. Generar un paquete con WF-022, descargarlo y validar aislamiento entre empresas.
12. Probar WF-023 contra inyección de instrucciones, fuga entre empresas y cuota agotada.
13. Contrastar el mapa con consultas SQL por departamento, municipio y pagaduría.
14. Probar Bold: firma inválida, rechazo, aprobación, duplicado, cupos 1/100/101 y renovación.
15. Validar recuperación/MFA y notificaciones con SMTP/WhatsApp reales.
16. Revisar permisos SQL y el alcance de RLS antes de usar una cuenta no propietaria.
17. Ejecutar y restaurar un backup en un destino de ensayo.
18. Repetir `npm audit --omit=dev` durante el despliegue.
