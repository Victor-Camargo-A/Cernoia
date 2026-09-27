import { pruneOldProcesses } from "../src/services/process-retention.js";
import { pool } from "../src/db.js";
const apply = process.argv.includes("--apply");
try {
  const results=[];
  for(let batch=0;batch<(apply?10:1);batch++) {
    const result=await pruneOldProcesses({dryRun:!apply,retentionDays:180,batchSize:100});results.push(result);
    if(result.skipped || !apply || result.deleted<100)break;
  }
  console.log(JSON.stringify({job:"cernoia_secop_retention",results}));
} catch(error) { console.error("La limpieza no se completó:",error.message);process.exitCode=1; }
finally {await pool.end();}
