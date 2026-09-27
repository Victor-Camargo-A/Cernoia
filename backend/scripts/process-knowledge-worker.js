import {processNextPreparation} from '../src/services/opportunity-preparation.js';
import 'dotenv/config';
import {processNextKnowledgeJob,refreshActiveBidMatrices} from '../src/services/process-knowledge.js';
import {closeMatrixAi} from '../src/services/company-matrix-ai.js';
import {pool} from '../src/db.js';
let stop=false,lastSweep=0;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
while(!stop){try{if(Date.now()-lastSweep>60000){await refreshActiveBidMatrices();lastSweep=Date.now();}await processNextPreparation();const result=await processNextKnowledgeJob();if(result)console.log(JSON.stringify({event:'public_process_matrix',...result}));}catch(e){console.error('Public matrix worker:',e.code??e.name);}if(process.argv.includes('--once'))break;await new Promise(r=>setTimeout(r,3000));}
await closeMatrixAi();await pool.end();process.exit(0);
