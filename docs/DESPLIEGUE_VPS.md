# Despliegue en VPS con dominio, HTTPS, PM2 y Nginx

> **No uses esta guía en el VPS actual.** Allí está instalado CloudPanel y existen varios sitios WordPress. Sigue `DESPLIEGUE_CLOUDPANEL_AGENTGLOBAL.md`; esa guía conserva los Vhosts y certificados administrados por CloudPanel.

## Requisitos

- Ubuntu 22.04 o 24.04.
- Node.js 22 o superior.
- PostgreSQL con los esquemas actuales `secop`, `saas` y `ops`.
- n8n activo en `https://n8n.secretbloom.tech`.
- Un subdominio para el frontend, por ejemplo `app.cernoia.com`, apuntando con registro A a la IP del VPS.

## Instalación automática

Desde la carpeta del proyecto:

```bash
chmod +x deploy/setup-vps.sh
./deploy/setup-vps.sh app.cernoia.com director@cernoia.com
```

El instalador solicita de forma interactiva:

- `DATABASE_URL`;
- UUID de la organización inicial;
- nombre, correo y contraseña del primer administrador.

Después:

1. instala Nginx, Certbot y PM2;
2. genera secretos distintos para JWT y n8n;
3. instala las dependencias con `npm ci`;
4. compila el frontend;
5. crea las tablas de autenticación;
6. crea el administrador;
7. inicia frontend y API con PM2;
8. configura Nginx;
9. solicita y activa el certificado SSL;
10. fuerza redirección de HTTP a HTTPS.

## Puertos internos

| Servicio | Puerto | Exposición |
|---|---:|---|
| Frontend React/Vinext | 3000 | Solo `127.0.0.1` |
| API Express | 4001 | Solo `127.0.0.1` |
| n8n | existente | `https://n8n.secretbloom.tech` |

Nginx publica el frontend y envía `/api/*` a Express. Express es el único servicio autorizado para llamar al webhook de n8n.

## Comandos de operación

```bash
pm2 status
pm2 logs cernoia-frontend --lines 100
pm2 logs cernoia-api --lines 100
curl -I https://app.cernoia.com
curl https://app.cernoia.com/api/health
sudo certbot renew --dry-run
```

## Actualización posterior

```bash
git pull
npm ci
npm --prefix backend ci
npm run build
npm --prefix backend run migrate
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save
```

## Comprobación final

- El dominio abre con candado HTTPS.
- `/api/health` responde `status: ok`.
- El inicio de sesión funciona.
- Las oportunidades corresponden únicamente a la organización autenticada.
- La sección Automatizaciones muestra n8n conectado.
- Ejecutar WF-019 devuelve una aceptación y crea registro en `ops.workflow_runs`.
