import {classifyNextCompany} from '../src/services/company-unspsc.js';
import {refreshNextSearchBatch} from '../src/services/search-refresh.js';import {pool,authPool} from '../src/db.js';
let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true});
while(!stopping){try{await classifyNextCompany();const result=await refreshNextSearchBatch();if(result)console.log(JSON.stringify(result));}catch(e){console.error('Search refresh:',e.message);}if(process.argv.includes('--once'))break;await new Promise(r=>setTimeout(r,2000));}
await Promise.all([pool.end(),authPool.end()]);process.exit(0);
