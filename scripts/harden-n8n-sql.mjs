#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = resolve(process.argv[2] ?? join(projectRoot, "n8n/workflows"));

function normalizeExpression(expression) {
  const value = expression
    .trim()
    .replace(/\.replace\(\/'\/g,\s*"''"\)/g, "")
    .replace(/\.replace\(\/'\/g,\s*'\'\''\)/g, "");
  if (value.includes("'::TIMESTAMPTZ") && value.includes("source_updated_at")) {
    return "$json.source_updated_at ? new Date($json.source_updated_at).toISOString() : null";
  }
  return value;
}

function parameterize(query) {
  const expressions = [];
  let cursor = 0;
  let output = "";
  const pattern = /'\{\{([\s\S]*?)\}\}'|\{\{([\s\S]*?)\}\}/g;
  let match;
  while ((match = pattern.exec(query))) {
    output += query.slice(cursor, match.index);
    const quoted = match[1] !== undefined;
    const expression = normalizeExpression(match[1] ?? match[2]);
    expressions.push(expression);
    const placeholder = `$${expressions.length}`;
    if (quoted && /INTERVAL\s*$/i.test(output)) {
      output = output.replace(/INTERVAL\s*$/i, "");
      output += `${placeholder}::INTERVAL`;
    } else if (quoted) {
      const existingCast = query.slice(pattern.lastIndex).trimStart().startsWith("::");
      output += existingCast ? placeholder : `${placeholder}::TEXT`;
    } else if (/^Number\s*\(/.test(expression)) {
      output += `${placeholder}::BIGINT`;
    } else if (expression.includes("source_updated_at") && expression.includes("toISOString")) {
      output += `${placeholder}::TIMESTAMPTZ`;
    } else {
      output += `${placeholder}::TEXT`;
    }
    cursor = pattern.lastIndex;
  }
  output += query.slice(cursor);
  return { query: output, expressions };
}

let changedFiles = 0;
let changedNodes = 0;
for (const filename of (await readdir(workflowDirectory)).filter((name) => name.endsWith(".json")).sort()) {
  const filePath = join(workflowDirectory, filename);
  const workflow = JSON.parse(await readFile(filePath, "utf8"));
  let changed = false;
  for (const node of workflow.nodes ?? []) {
    if (node.type !== "n8n-nodes-base.postgres") continue;
    const original = String(node.parameters?.query ?? "");
    if (!original.includes("{{")) continue;
    const hardened = parameterize(original);
    node.parameters.query = hardened.query;
    node.parameters.options = {
      ...(node.parameters.options ?? {}),
      queryReplacement: `={{ [ ${hardened.expressions.join(", ")} ] }}`,
    };
    changed = true;
    changedNodes += 1;
  }
  if (changed) {
    await writeFile(filePath, `${JSON.stringify(workflow, null, 2)}\n`);
    changedFiles += 1;
  }
}

console.log(`SQL reforzado: ${changedNodes} nodos en ${changedFiles} workflows.`);
