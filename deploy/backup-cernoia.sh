#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

CERN_APP_DIR="${1:-/home/cernoia/htdocs/cernoia.secretbloom.tech}"
CERN_ENV_FILE="${2:-${CERN_APP_DIR}/backend/.env}"
CERN_BACKUP_DIR="${3:-/var/backups/cernoia}"

if [[ ! -d "$CERN_APP_DIR" || ! -f "$CERN_ENV_FILE" ]]; then
  echo "No se encontró el proyecto o backend/.env."
  echo "Uso: $0 RUTA_PROYECTO RUTA_ENV DIRECTORIO_BACKUPS" >&2
  exit 2
fi

for CERN_COMMAND in node pg_dump tar sha256sum; do
  command -v "$CERN_COMMAND" >/dev/null 2>&1 || {
    echo "Falta el comando requerido: $CERN_COMMAND" >&2
    exit 3
  }
done

CERN_DATABASE_URL="$(cd "${CERN_APP_DIR}/backend" && node -e 'const fs=require("node:fs"),dotenv=require("dotenv"); const values=dotenv.parse(fs.readFileSync(process.argv[1])); process.stdout.write(values.DATABASE_URL || "")' "$CERN_ENV_FILE")"
CERN_DOCUMENT_DIR="$(cd "${CERN_APP_DIR}/backend" && node -e 'const fs=require("node:fs"),dotenv=require("dotenv"); const values=dotenv.parse(fs.readFileSync(process.argv[1])); process.stdout.write(values.DOCUMENT_STORAGE_PATH || "")' "$CERN_ENV_FILE")"

if [[ -z "$CERN_DATABASE_URL" || -z "$CERN_DOCUMENT_DIR" || "$CERN_DOCUMENT_DIR" == "/" ]]; then
  echo "DATABASE_URL o DOCUMENT_STORAGE_PATH no son válidos en el archivo de entorno." >&2
  exit 4
fi

mkdir -p -- "$CERN_BACKUP_DIR"
CERN_TEMP_DIR="$(mktemp -d /tmp/cernoia-backup.XXXXXX)"
trap 'rm -rf -- "$CERN_TEMP_DIR"' EXIT
CERN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CERN_ARCHIVE="${CERN_BACKUP_DIR}/cernoia-${CERN_STAMP}.tar.gz"

pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --dbname="$CERN_DATABASE_URL" --file="${CERN_TEMP_DIR}/database.dump"

if [[ -d "$CERN_DOCUMENT_DIR" ]]; then
  tar -C "$CERN_DOCUMENT_DIR" -czf "${CERN_TEMP_DIR}/documents.tar.gz" .
else
  tar -czf "${CERN_TEMP_DIR}/documents.tar.gz" --files-from /dev/null
fi

{
  echo "created_at_utc=${CERN_STAMP}"
  echo "application_dir=${CERN_APP_DIR}"
  echo "documents_included=true"
  echo "secrets_included=false"
} > "${CERN_TEMP_DIR}/manifest.txt"

(
  cd "$CERN_TEMP_DIR"
  sha256sum database.dump documents.tar.gz manifest.txt > checksums.sha256
  tar -czf "$CERN_ARCHIVE" database.dump documents.tar.gz manifest.txt checksums.sha256
)

sha256sum "$CERN_ARCHIVE" > "${CERN_ARCHIVE}.sha256"
echo "Respaldo creado: $CERN_ARCHIVE"
echo "El archivo .env y sus secretos no fueron incluidos."
