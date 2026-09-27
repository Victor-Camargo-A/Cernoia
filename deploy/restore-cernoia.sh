#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

CERN_ARCHIVE="${1:-}"
CERN_ENV_FILE="${2:-}"
CERN_CONFIRMATION="${3:-}"

if [[ -z "$CERN_ARCHIVE" || -z "$CERN_ENV_FILE" || ! -f "$CERN_ARCHIVE" || ! -f "$CERN_ENV_FILE" ]]; then
  echo "Uso: $0 ARCHIVO_BACKUP RUTA_ENV RESTORE-CERNOIA-NOMBRE_BASE" >&2
  exit 2
fi

for CERN_COMMAND in node pg_dump pg_restore tar sha256sum; do
  command -v "$CERN_COMMAND" >/dev/null 2>&1 || {
    echo "Falta el comando requerido: $CERN_COMMAND" >&2
    exit 3
  }
done

CERN_BACKEND_DIR="$(cd "$(dirname "$CERN_ENV_FILE")" && pwd)"
CERN_DATABASE_URL="$(cd "$CERN_BACKEND_DIR" && node -e 'const fs=require("node:fs"),dotenv=require("dotenv"); const values=dotenv.parse(fs.readFileSync(process.argv[1])); process.stdout.write(values.DATABASE_URL || "")' "$CERN_ENV_FILE")"
CERN_DOCUMENT_DIR="$(cd "$CERN_BACKEND_DIR" && node -e 'const fs=require("node:fs"),dotenv=require("dotenv"); const values=dotenv.parse(fs.readFileSync(process.argv[1])); process.stdout.write(values.DOCUMENT_STORAGE_PATH || "")' "$CERN_ENV_FILE")"
CERN_DATABASE_NAME="$(node -e 'const value=new URL(process.argv[1]); process.stdout.write(value.pathname.replace(/^\//, ""))' "$CERN_DATABASE_URL")"

if [[ -z "$CERN_DATABASE_NAME" || "$CERN_DATABASE_NAME" =~ ^(postgres|template0|template1)$ ]]; then
  echo "La base de destino no es una base dedicada válida para CernoIA." >&2
  exit 4
fi
if [[ -z "$CERN_DOCUMENT_DIR" || "$CERN_DOCUMENT_DIR" == "/" ]]; then
  echo "DOCUMENT_STORAGE_PATH no es una ruta segura." >&2
  exit 4
fi
if [[ "$CERN_CONFIRMATION" != "RESTORE-CERNOIA-${CERN_DATABASE_NAME}" ]]; then
  echo "Restauración cancelada. Confirma con: RESTORE-CERNOIA-${CERN_DATABASE_NAME}" >&2
  exit 5
fi

CERN_TEMP_DIR="$(mktemp -d /tmp/cernoia-restore.XXXXXX)"
trap 'rm -rf -- "$CERN_TEMP_DIR"' EXIT
tar -xzf "$CERN_ARCHIVE" -C "$CERN_TEMP_DIR"
(
  cd "$CERN_TEMP_DIR"
  sha256sum --check checksums.sha256
)

CERN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CERN_SAFETY_DUMP="$(dirname "$CERN_ARCHIVE")/before-restore-${CERN_DATABASE_NAME}-${CERN_STAMP}.dump"
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --dbname="$CERN_DATABASE_URL" --file="$CERN_SAFETY_DUMP"

pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
  --dbname="$CERN_DATABASE_URL" "${CERN_TEMP_DIR}/database.dump"

if [[ -d "$CERN_DOCUMENT_DIR" ]]; then
  mv -- "$CERN_DOCUMENT_DIR" "${CERN_DOCUMENT_DIR}.before-restore-${CERN_STAMP}"
fi
mkdir -p -- "$CERN_DOCUMENT_DIR"
tar -xzf "${CERN_TEMP_DIR}/documents.tar.gz" -C "$CERN_DOCUMENT_DIR"

echo "Restauración completada para la base dedicada: $CERN_DATABASE_NAME"
echo "Respaldo de seguridad previo: $CERN_SAFETY_DUMP"
