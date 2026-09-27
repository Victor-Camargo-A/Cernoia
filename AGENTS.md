# CernoIA — instrucciones de sesión

Antes de cualquier tarea de CernoIA:

1. Leer `CERNOIA_CONTEXT.md` y ejecutar `git status --short` como `cernoiaapp`.
2. Aplicar la política eficiente: localizar, leer lo mínimo, modificar lo mínimo, probar sólo lo afectado y documentar.
3. No redescubrir arquitectura, infraestructura, n8n, Redis, base de datos, autenticación o despliegue salvo que la tarea lo requiera o el contexto sea insuficiente.
4. Excluir búsquedas recursivas en dependencias, builds, backups, caches y logs.

Al completar una tarea, actualizar `CERNOIA_CONTEXT.md` sólo con cambios materiales o pendientes vigentes. Mantenerlo como estado compacto, no como registro de cada comando. No incluir secretos. Para retomar una sesión VPS, usar `$vps-session`.
