# CernoIA: biblioteca y publicación en YouTube

Implementado el 17 de septiembre de 2026. Acceso: `/acceso` → **Videos y YouTube**, visible únicamente para la cuenta designada como propietaria de CernoIA en `saas.campaign_settings.owner_user_id`. Ser propietario de otra organización no da acceso. Se reutiliza la autenticación existente, sin crear cuentas ni modificar contraseñas.

## Alcance

Se importa el primer MVP `hsp-001` como borrador privado. El reproductor y las imágenes usan rutas autenticadas; los archivos se encuentran fuera del directorio público, en `/home/cernoiaapp/private/youtube/hsp-001/`. El original permanece en `/opt/youtube-solar-ai/`. Esta versión no descubre proyectos nuevos automáticamente ni vuelve a renderizar videos. El video requiere revisión humana: el control automático anterior no certifica calidad editorial, sincronización de subtítulos ni derechos comerciales.

La miniatura original se genera localmente con Pillow, a doble resolución y se reduce a JPEG 1280 × 720, calidad 92, sin API ni tokens. También se genera una portada vertical 1080 × 1920 para el reproductor y para descargar. Script reproducible: `thumbnail.py` en esta carpeta de trabajo. Google documenta opciones específicas de miniaturas para Shorts en YouTube Studio; la aceptación del método API y la visualización en cada superficie deben comprobarse con el canal real. Si Google rechaza la miniatura, el video cargado se conserva y no se vuelve a subir.

## Conexión: pasos del propietario

1. Tener una cuenta de Google con acceso al canal de YouTube que recibirá los videos. No facilitar la contraseña a CernoIA.
2. Ir a https://console.cloud.google.com/ y crear un proyecto, por ejemplo `CernoIA YouTube`. No activar facturación ni contratar servicios para este módulo.
3. En **APIs y servicios → Biblioteca**, habilitar **YouTube Data API v3**.
4. En **Google Auth Platform**, configurar marca, correo de soporte y audiencia externa o interna según corresponda. En modo de prueba externo, añadir el correo del propietario en usuarios de prueba.
5. Crear un cliente OAuth **Aplicación web**. URI autorizada de redirección exacta:
   `https://cernoia.energeticanika.com/api/platform/youtube/oauth/callback`
6. Introducir el ID y secreto en **Videos y YouTube → Conectar tu canal**. No enviarlos por chat. El formulario los transmite por HTTPS y el servidor los cifra con la clave de datos existente.
7. Pulsar **Autorizar canal**, seleccionar la cuenta y canal correctos, aceptar los permisos y comprobar el nombre del canal al regresar.
8. Ver el video completo; revisar audio, subtítulos, fórmulas, derechos, miniatura y metadatos. Guardar los cambios, marcar la revisión y pulsar **Enviar a YouTube** con la visibilidad elegida.

Se solicitan los permisos `youtube.upload` y `youtube.readonly`: carga/miniatura y confirmación de identidad del canal. No se usa API key de YouTube. No se necesita Gemini para este MVP ni la API de OpenAI.

Los proyectos API no auditados pueden tener las cargas restringidas a privadas. La selección «Público» no evita esa restricción. La auditoría de YouTube es distinta de la verificación OAuth. En modo OAuth externo de prueba los refresh tokens caducan normalmente a los 7 días; habrá que reconectar o completar la configuración de producción que Google exija.

Referencias oficiales verificadas:
- https://developers.google.com/youtube/v3/docs/videos/insert
- https://developers.google.com/youtube/v3/docs/thumbnails/set
- https://developers.google.com/identity/protocols/oauth2
- https://support.google.com/youtube/answer/72431

## Envío y recuperación

`saas.youtube_videos` conserva metadatos, revisión, identidad que autorizó, canal seleccionado, estado, intentos, sesión resumible cifrada e ID remoto. El guardado utiliza revisión optimista. La solicitud de envío cambia atómicamente `draft → queued` y rechaza dobles clics. Las modificaciones de metadatos invalidan la revisión.

Un despachador en `cernoia-api` revisa la cola cada 15 segundos; un bloqueo asesor PostgreSQL permite una sola transferencia simultánea incluso con varias instancias de API. El envío no mantiene abierta la petición del navegador. Reintenta hasta tres veces, con dos minutos entre intentos. Después permite reintento manual. Al reiniciar, consulta la sesión resumible y continúa desde el byte confirmado. Si la sesión expiró y no se puede descartar una carga completada, se detiene en `needs_attention`: comprobar YouTube Studio antes de cualquier intervención administrativa. Nunca borrar la sesión para forzar automáticamente una carga nueva.

El ID remoto se guarda antes de enviar la miniatura. Si esta falla, el enlace al video sigue disponible y el reintento solo envía la imagen. El estado `uploaded` significa que YouTube aceptó el archivo y la miniatura; no certifica que haya terminado su procesamiento ni que sea público.

Las credenciales y tokens de renovación están cifrados en `saas.youtube_settings` mediante AES-256-GCM. El callback usa estado de un solo uso, con vencimiento de diez minutos, vinculado al navegador y a la cuenta propietaria activa. No se devuelven secretos al navegador. El botón Desconectar revoca la autorización en Google antes de eliminar el token local.

## Operación

Servicio existente: `cernoia-api` bajo PM2 del usuario `cernoiaapp`. No se añade Nginx, Docker, n8n ni otro servicio público. El frontend sigue en `cernoia-frontend`.

Reiniciar API:
```sh
runuser -u cernoiaapp -- /home/cernoiaapp/.nvm/versions/node/v24.20.0/bin/node /home/cernoiaapp/.nvm/versions/node/v24.20.0/bin/pm2 restart cernoia-api
```

Consultar salud: `GET /api/health`. Logs PM2: buscar `[YouTube] project=... status=... attempt=...`. Los errores de Google se reducen al código HTTP y motivo sin cabeceras, tokens ni URL de carga.

Diagnóstico: 401 indica sesión vencida; 403 local indica permisos/CSRF; 403 de Google puede indicar cuota o función no habilitada. `invalid_grant` requiere reconectar. Si el video aparece pero la miniatura falla, habilitar funciones de miniatura en YouTube Studio y reintentar; no recrear el video. En `needs_attention`, resolver la incertidumbre en Studio con intervención administrativa.

## Comprobaciones y reversión

Pruebas incluidas en esta carpeta: `test-api.mjs`, `test-worker.mjs`, `test-browser.mjs`. El worker se prueba con todas las llamadas a Google simuladas; no se ha probado OAuth o publicación reales sin credenciales. El navegador se verifica en escritorio y móvil; las sesiones temporales de pruebas se eliminan al finalizar.

Fuentes anteriores: `backup/`. Para revertir, restaurar `backend/src/server.js`, `app/components/dashboard-shell.tsx` y `app/components/dashboard/shared.tsx` desde sus respaldos; volver al directorio `dist-before-youtube-20260917` y reiniciar solo API/frontend. Conservar tablas y archivos privados; no borrarlos, especialmente si en el futuro contienen envíos reales. Detener o resolver cargas activas antes de revertir.
