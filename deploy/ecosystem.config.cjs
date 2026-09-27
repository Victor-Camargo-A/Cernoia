/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "cernoia-frontend",
      cwd: projectRoot,
      script: "npm",
      args: "start -- --port 3000 --hostname 127.0.0.1",
      instances: 1,
      autorestart: true,
      max_memory_restart: "450M",
      env: { NODE_ENV: "production", PORT: "3000" },
    },
    {
      name: "cernoia-api",
      cwd: path.join(projectRoot, "backend"),
      script: "npm",
      args: "start",
      instances: 1,
      autorestart: true,
      max_memory_restart: "350M",
      env: { NODE_ENV: "production", PORT: "4001" },
    },
  ],
};
