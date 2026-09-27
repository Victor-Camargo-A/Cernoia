import {queueNewMetadata,processNextMetadataJob} from '../src/services/document-metadata-jobs.js';
import {pool,authPool} from '../src/db.js';
let stopping=false;
process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
while(!stopping){
 try{await queueNewMetadata();const result=await processNextMetadataJob();if(result)console.log(JSON.stringify(result));if(process.argv.includes('--once'))break;if(result)continue;}
 catch(error){console.error('Document metadata worker:',error.message);}
 await new Promise(r=>setTimeout(r,5000));
}
await Promise.all([pool.end(),authPool.end()]);

process.exit(0);
