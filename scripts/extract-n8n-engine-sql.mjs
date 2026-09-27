#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(process.argv[2] ?? "");
const outputFile = join(projectRoot, "backend/sql/003_workflow_engines.sql");

if (!process.argv[2]) {
  throw new Error("Uso: node scripts/extract-n8n-engine-sql.mjs <carpeta-con-json-originales>");
}

const files = await readdir(sourceDirectory);
const workflow000File = files.find((name) => name.startsWith("WF-000") && name.endsWith(".json"));
const workflow018File = files.find((name) => name.startsWith("WF-018") && name.endsWith(".json"));

if (!workflow000File || !workflow018File) {
  throw new Error("No se encontraron WF-000 y WF-018 en la carpeta indicada.");
}

const workflow000 = JSON.parse(await readFile(join(sourceDirectory, workflow000File), "utf8"));
const workflow018 = JSON.parse(await readFile(join(sourceDirectory, workflow018File), "utf8"));

const sections = [
  [workflow000, "WF-000 - Inicialización BD SECOP SaaS1"],
  [workflow000, "Configurar versionado automático"],
  [workflow000, "Nombre: Crear eventos de cambios WF-002 Credential: Postgres account Operation: Execute Query"],
  [workflow000, "Crear función consolidación WF-016"],
  [workflow000, "Crear estructura base WF-017"],
  [workflow000, "Crear motor de evaluación WF-017"],
  [workflow000, "Crear motor V3 WF-017"],
  [workflow018, "Crear estructura base WF-018"],
  [workflow018, "Crear motor V1 WF-018"],
];

const sql = sections.map(([workflow, nodeName]) => {
  const node = workflow.nodes.find((candidate) => candidate.name === nodeName);
  const query = node?.parameters?.query;
  if (!query) throw new Error(`El nodo ${nodeName} no contiene SQL.`);
  return `\n-- ============================================================\n-- Fuente auditada: ${nodeName}\n-- ============================================================\n\n${query.trim()}\n`;
});

const header = `-- Generado a partir de los DDL proporcionados por el propietario del proyecto.\n-- No contiene datos piloto, limpiezas manuales ni pruebas destructivas.\n`;

await writeFile(outputFile, `${header}${sql.join("\n")}\n`, "utf8");
console.log(`Migración generada: ${outputFile}`);
