# Integración segura del frontend con WF-019

La URL correcta de n8n es `https://n8n.secretbloom.tech`.

El navegador no llama directamente a n8n. La ruta segura es:

`Frontend -> /api/workflows/WF-019/run -> API Express -> webhook autenticado de n8n -> WF-019`

## Configuración en n8n

1. Abre `WF-019`.
2. Agrega un nodo **Webhook** junto al disparador manual.
3. Configúralo así:

   - HTTP Method: `POST`
   - Path: `cernoia/wf-019`
   - Authentication: `Header Auth`
   - Respond: `When Last Node Finishes`
   - Response Data: `First Entry JSON`

4. Crea una credencial **Header Auth**:

   - Name: `Cernoia API -> n8n`
   - Header Name: `Authorization`
   - Header Value: `Bearer EL_VALOR_DE_N8N_WEBHOOK_SECRET`

   El valor debe ser exactamente el mismo de `backend/.env`. Nunca lo pongas en React ni en una variable `NEXT_PUBLIC_*`.

5. Conecta la salida del Webhook al mismo primer nodo de lógica que usa el inicio manual: **Configurar orquestación WF-019**.
6. En ese nodo conserva los datos enviados por el webhook:

```javascript
const input = $json.body ?? $json;

return [{
  json: {
    ...input,
    organization_id: input.organization_id ?? null,
    requested_by_user_id: input.requested_by_user_id ?? null,
    processing_mode: input.processing_mode ?? 'all',
    frontend_triggered: true,
    frontend_requested_at: input.requested_at ?? new Date().toISOString(),
  },
}];
```

7. Conecta después los subworkflows en el orden ya definido:

   - WF-005
   - WF-014
   - WF-015

8. Activa WF-019 y prueba la URL de producción:

`https://n8n.secretbloom.tech/webhook/cernoia/wf-019`

## Workflows individuales

La interfaz no expone botones para WF-005, WF-014 o WF-015. La API rechaza su ejecución manual: únicamente WF-019 puede iniciar el pipeline y debe controlar el orden. Esto evita que un usuario deje la información en un estado parcial.

## Seguridad

- No habilites CORS abierto en n8n para el frontend.
- No publiques la API key administrativa de n8n.
- No uses la URL `/webhook-test/` en producción.
- Rota `N8N_WEBHOOK_SECRET` si alguna vez se expone.
- La API también envía `X-Cernoia-Signature` con HMAC-SHA256 para una validación adicional futura.
- Cada escritura de `ops.workflow_runs` debe incluir `metadata.organization_id`; la API oculta ejecuciones sin ese dato para impedir cruces entre clientes.
