# CernoIA — Inteligencia de mercados públicos

Aplicación privada para convertir contratación pública en oportunidades priorizadas, requisitos claros y decisiones comerciales accionables.

## Estado del producto

El repositorio incluye un frontend responsive en React/Vinext y una API Express conectada a PostgreSQL y n8n.

Funciones disponibles:

- autenticación con JWT en cookie segura, sesiones revocables, CSRF, bloqueo de intentos y roles;
- panel ejecutivo de oportunidades, valor potencial, afinidad, cierres y documentación;
- búsqueda, filtros, favoritos, etapas comerciales y notas;
- detalle de oportunidad con análisis, requisitos, cobertura y documentos fuente;
- carga, descarga, validación y control de vigencias de documentos empresariales;
- clasificación asistida de tipo empresarial y fechas documentales con confirmación humana;
- alertas persistentes de cierres y vencimientos, con resumen inteligente diario;
- control central de RPM/RPD de Gemini mediante Redis y fallback sin IA;
- Chat CernoIA con contexto privado, citas, límites y agente controlado por n8n;
- mapa de calor de contratación con navegación Colombia → departamento → municipio → pagaduría;
- preparación, autollenado y descarga privada de documentos y paquetes de propuesta;
- firma electrónica simple opcional con consentimiento, huella y auditoría por paquete;
- cobro mensual mediante enlaces Bold, webhook firmado e idempotencia;
- reserva transaccional de 100 cupos fundadores a COP 250.000/mes, por máximo 12 ciclos dentro del primer año;
- plan empresarial posterior de COP 1.200.000/mes y control de funcionalidades por suscripción;
- correo y WhatsApp verificables, bandeja de salida, reintentos y cola de errores;
- MFA TOTP, recuperación de contraseña y cifrado AES-256-GCM de secretos/archivos;
- revisión humana de OCR, políticas documentales, antivirus y plantillas versionadas;
- copias de seguridad verificables y restauración protegida;
- actualización integral a través de n8n sin exponer secretos ni subworkflows internos;
- preferencias de la organización y gestión privada del equipo;
- invitaciones de un solo uso para el equipo, sin contraseñas temporales compartidas;
- onboarding guiado de empresa, capacidades y perfil de búsqueda;
- consola global independiente en `/platform`, con administradores que no pertenecen a una organización cliente;
- RLS de defensa en profundidad y contexto transaccional de `organization_id`;
- auditoría de acciones sensibles y separación por `organization_id`.

## Arquitectura

```text
Navegador HTTPS
  └─ cernoia.secretbloom.tech
      ├─ /       → Vinext/React en 127.0.0.1:3000
      └─ /api/*  → Express en 127.0.0.1:4001
                     ├─ PostgreSQL: secop, saas y ops
                     ├─ documentos cifrados + ClamAV + OCR
                     ├─ Bold, notificaciones y plantillas
                     ├─ mapa territorial y Chat CernoIA
                     └─ webhook firmado → n8n.secretbloom.tech
                                             ├─ WF-020 → Redis local
                                             └─ WF-000…WF-026 (23 flujos)
```

PostgreSQL se conserva como fuente de verdad. No se agregó MongoDB porque duplicaría organizaciones, procesos y documentos existentes.

## Requisitos

- Node.js 22 o superior;
- PostgreSQL con los esquemas actuales `secop`, `saas` y `ops`;
- npm;
- n8n para las automatizaciones;
- Redis local protegido para el control compartido de cuota de Gemini;
- ClamAV/clamd para analizar cargas en producción;
- Poppler para extracción de PDF y acceso saliente para el modelo OCR configurado;
- cuenta Bold con llaves de integración para habilitar pagos;
- SMTP y/o WhatsApp Cloud API para entregar alertas fuera de la aplicación.

## Desarrollo local

```bash
cp backend/.env.example backend/.env
# Edita backend/.env para el entorno local

npm ci
npm --prefix backend ci
npm --prefix backend run migrate
```

Terminal 1:

```bash
npm --prefix backend run dev
```

Terminal 2:

```bash
npm run dev
```

En producción, Nginx publica ambas aplicaciones bajo el mismo dominio y enruta `/api` a Express.

## Crear el primer propietario

```bash
npm --prefix backend run list-organizations
read -rsp "Contraseña inicial: " CERNOIA_ADMIN_PASSWORD; echo
export CERNOIA_ADMIN_PASSWORD
npm --prefix backend run create-admin -- --email=correo@empresa.com --name="Nombre completo" --organization=UUID
unset CERNOIA_ADMIN_PASSWORD
```

## Crear el primer administrador global de plataforma

La consola `/platform` no reutiliza cuentas de clientes ni permite cambiar de organización. Créalo después de aplicar las migraciones:

```bash
read -rsp "Contraseña del administrador global: " CERNOIA_PLATFORM_PASSWORD; echo
export CERNOIA_PLATFORM_PASSWORD
npm --prefix backend run create-platform-admin -- --email=plataforma@tu-dominio.com --name="Administrador CernoIA"
unset CERNOIA_PLATFORM_PASSWORD
```

## Verificación

```bash
npm run lint
npm run build
npm test
npm --prefix backend test
npm audit --omit=dev
npm --prefix backend audit --omit=dev
npm run audit:workflows
```

## Documentación

- `docs/AUDITORIA_INTEGRAL.md`: hallazgos, correcciones y límites de validación.
- `docs/IMPLEMENTACION_PUNTOS_2_A_8.md`: alcance implementado, arquitectura y aceptación de producto.
- `docs/DESPLIEGUE_CLOUDPANEL_AGENTGLOBAL.md`: publicación paso a paso en el VPS actual sin afectar WordPress.
- `n8n/INTEGRACION_WF019.md`: entrada segura desde la API hacia la orquestación.
- `n8n/ESTADO_E_INTEGRACION.md`: mapa real de los 23 workflows y tareas externas pendientes.
- `docs/FASE_2_REDIS_ALERTAS_PROPUESTAS.md`: referencia de Redis, alertas, propuestas y firma.

No uses `deploy/setup-vps.sh` en el servidor actual: es un instalador genérico y se detiene automáticamente si detecta CloudPanel.

## Secretos

Nunca guardes `backend/.env` en Git ni expongas `DATABASE_URL`, `JWT_SECRET` o `N8N_WEBHOOK_SECRET` en React, variables `NEXT_PUBLIC_*`, capturas o conversaciones. El navegador solo se comunica con `/api` en el dominio de la aplicación.
