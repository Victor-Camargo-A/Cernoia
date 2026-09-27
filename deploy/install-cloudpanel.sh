#!/usr/bin/env bash
set -euo pipefail

# Este instalador prepara únicamente la aplicación. CloudPanel conserva el
# control de Nginx, DNS y certificados, por lo que no modifica otros sitios.

if [[ "$(id -u)" -eq 0 ]]; then
  echo "ERROR: ejecuta este archivo con el Site User de cernoia.secretbloom.tech, no como root."
  echo "Desde la terminal root usa: su - NOMBRE_DEL_SITE_USER"
  exit 77
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${project_root}"

for command_name in node npm; do
  command -v "${command_name}" >/dev/null || { echo "ERROR: no encuentro ${command_name}. Verifica el sitio Node.js en CloudPanel."; exit 69; }
done

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major < 22 )); then
  echo "ERROR: CernoIA requiere Node.js 22 o superior; la sesión actual usa $(node -v)."
  echo "Selecciona Node.js 22 en CloudPanel y vuelve a iniciar sesión con el Site User."
  exit 69
fi

if [[ ! -f backend/.env ]]; then
  echo "ERROR: falta backend/.env. Copia backend/.env.example y completa sus valores antes de continuar."
  exit 78
fi

echo "1/6 Instalando dependencias del frontend..."
npm ci

echo "2/6 Instalando dependencias de la API..."
npm --prefix backend ci

echo "3/6 Preparando almacenamiento privado..."
storage_path="$(node --input-type=module -e 'import fs from "node:fs"; import dotenv from "./backend/node_modules/dotenv/lib/main.js"; const v=dotenv.parse(fs.readFileSync("backend/.env")).DOCUMENT_STORAGE_PATH; if (!v) process.exit(2); process.stdout.write(v);')" || {
  echo "ERROR: DOCUMENT_STORAGE_PATH no está definido en backend/.env."
  exit 78
}
mkdir -p "${storage_path}"
chmod 750 "${storage_path}"

echo "4/6 Compilando la aplicación..."
npm run build

echo "5/6 Aplicando migraciones seguras..."
npm --prefix backend run migrate

echo "6/6 Iniciando frontend y API con PM2..."
if ! command -v pm2 >/dev/null; then
  npm install --global pm2@latest
fi
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save

echo
echo "CernoIA quedó iniciada en puertos privados 3000 (frontend) y 4001 (API)."
echo "Siguiente paso: agrega el bloque de deploy/cloudpanel-api-location.conf en el Vhost de CloudPanel."
echo "Después configura el cron @reboot de PM2 indicado en la guía para que la app vuelva tras reiniciar el VPS."
echo "Comprobación local: curl http://127.0.0.1:4001/api/health"
