import { processNextMatrixJob,queueDailyMatrixRefresh } from '../src/services/company-matrix.js';
import { closeMatrixAi } from '../src/services/company-matrix-ai.js';
import { resumeMatrixAnalyses } from '../src/services/matrix-analysis-dispatch.js';
import { pool } from '../src/db.js';
let stopping=false;let lastSweep=0;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){
 try{
  if(Date.now()-lastSweep>600000){await queueDailyMatrixRefresh();lastSweep=Date.now();}
  await resumeMatrixAnalyses();
  const result=await processNextMatrixJob();
  if(result)console.log(JSON.stringify({event:'company_matrix',...result}));
  await resumeMatrixAnalyses();
  if(process.argv.includes('--once'))break;
 }catch(error){console.error('Company matrix worker:',error.code??error.name);}
 await new Promise(resolve=>setTimeout(resolve,5000));
}
await closeMatrixAi();await pool.end();
