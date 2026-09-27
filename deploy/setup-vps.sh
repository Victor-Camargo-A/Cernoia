#!/usr/bin/env bash
set -euo pipefail

if command -v clpctl >/dev/null 2>&1; then
  echo "CloudPanel detectado: este instalador genérico no se ejecutará para proteger los Vhosts existentes."
  echo "Usa docs/DESPLIEGUE_CLOUDPANEL_AGENTGLOBAL.md y ejecuta deploy/install-cloudpanel.sh con el Site User."
  exit 78
fi

if [[ $# -ne 2 ]]; then
  echo "Uso: ./deploy/setup-vps.sh app.tudominio.com correo@tudominio.com"
  exit 64
fi

app_domain="$1"
ssl_email="$2"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! "${app_domain}" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "El dominio no es válido: ${app_domain}" >&2
  exit 64
fi

for command_name in node npm openssl sudo; do
  command -v "${command_name}" >/dev/null || { echo "Falta ${command_name}." >&2; exit 69; }
done

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major < 22 )); then
  echo "Se requiere Node.js 22 o superior." >&2
  exit 69
fi

echo "Instalando Nginx, Certbot y PM2..."
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
command -v pm2 >/dev/null || sudo npm install -g pm2

backend_env="${project_root}/backend/.env"
if [[ ! -f "${backend_env}" ]]; then
  read -rsp "DATABASE_URL de PostgreSQL: " database_url
  echo
  read -rp "UUID de la organización inicial: " organization_id
  read -rp "Nombre del administrador: " admin_name
  read -rp "Correo del administrador: " admin_email
  read -rsp "Contraseña del administrador (mínimo 12 caracteres): " admin_password
  echo

  jwt_secret="$(openssl rand -hex 48)"
  webhook_secret="$(openssl rand -hex 40)"

  umask 077
  {
    echo "NODE_ENV=production"
    echo "PORT=4001"
    echo "DATABASE_URL=${database_url}"
    echo "DATABASE_SSL=false"
    echo "JWT_SECRET=${jwt_secret}"
    echo "JWT_EXPIRES_IN=8h"
    echo "COOKIE_NAME=cernoia_session"
    echo "APP_ORIGIN=https://${app_domain}"
    echo "ALLOWED_ORIGINS=https://${app_domain}"
    echo "N8N_BASE_URL=https://n8n.secretbloom.tech"
    echo "N8N_HEALTH_URL=https://n8n.secretbloom.tech/healthz"
    echo "N8N_WF019_WEBHOOK_URL=https://n8n.secretbloom.tech/webhook/cernoia/wf-019"
    echo "N8N_WF005_WEBHOOK_URL="
    echo "N8N_WF014_WEBHOOK_URL="
    echo "N8N_WF015_WEBHOOK_URL="
    echo "N8N_WEBHOOK_SECRET=${webhook_secret}"
    echo "N8N_TIMEOUT_MS=120000"
  } > "${backend_env}"
  chmod 600 "${backend_env}"
else
  echo "Se conserva backend/.env existente."
  organization_id=""
  admin_name=""
  admin_email=""
  admin_password=""
fi

echo "Instalando dependencias y compilando..."
cd "${project_root}"
npm ci
npm --prefix backend ci
npm run build
npm --prefix backend run migrate

if [[ -n "${organization_id:-}" ]]; then
  npm --prefix backend run create-admin -- \
    "--email=${admin_email}" \
    "--name=${admin_name}" \
    "--organization=${organization_id}" \
    "--password=${admin_password}"
fi

pm2 startOrReload "${project_root}/deploy/ecosystem.config.cjs" --update-env
pm2 save

temporary_nginx="$(mktemp)"
sed "s/__APP_DOMAIN__/${app_domain}/g" "${project_root}/deploy/nginx-cernoia.conf.template" > "${temporary_nginx}"
sudo install -m 0644 "${temporary_nginx}" "/etc/nginx/sites-available/cernoia-${app_domain}.conf"
rm -f "${temporary_nginx}"
sudo ln -sfn "/etc/nginx/sites-available/cernoia-${app_domain}.conf" "/etc/nginx/sites-enabled/cernoia-${app_domain}.conf"
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d "${app_domain}" --non-interactive --agree-tos -m "${ssl_email}" --redirect
sudo nginx -t
sudo systemctl reload nginx

echo
echo "Cernoia quedó publicada en https://${app_domain}"
echo "Configura en n8n una credencial Header Auth con el valor Bearer de N8N_WEBHOOK_SECRET guardado en backend/.env."
echo "Comprueba servicios con: pm2 status"
