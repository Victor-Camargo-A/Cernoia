import {query,pool} from '../db.js';
import {decryptSecret} from '../services/secret-box.js';
import {mkdir,readFile,writeFile,stat,statfs,rename,rm,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mediaRoot,runtimeRoot,storageBytes} from '../routes/video-factory-routes.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const schema={type:'OBJECT',properties:{brand:{type:'STRING',enum:['nika','cernoia']},title:{type:'STRING'},topic_key:{type:'STRING'},description:{type:'STRING'},thumbnail_text:{type:'STRING'},tags:{type:'ARRAY',items:{type:'STRING'}},requires_current_verification:{type:'BOOLEAN'},sources:{type:'ARRAY',items:{type:'STRING'}},scenes:{type:'ARRAY',items:{type:'OBJECT',properties:{voice:{type:'STRING'},screen_text:{type:'STRING'},key_point:{type:'STRING'},stock_query:{type:'STRING'},visual:{type:'STRING',enum:['stock','curve','formula']},formula:{type:'STRING'}},required:['voice','screen_text','key_point','stock_query','visual','formula']}}},required:['brand','title','topic_key','description','thumbnail_text','tags','requires_current_verification','sources','scenes']};
function fitCaption(text,max){if(typeof text!=='string'||text.length<=max)return text;const cut=text.slice(0,max-1);const space=cut.lastIndexOf(' ');return (space>max/2?cut.slice(0,space):cut).trimEnd()+'…';}
export function validateStory(s){
 if(!s||!['nika','cernoia'].includes(s.brand)||typeof s.title!=='string'||s.title.length>100||s.title.length<8||!s.topic_key||typeof s.description!=='string'||s.description.length>3500||typeof s.thumbnail_text!=='string'||s.thumbnail_text.length>50||!Array.isArray(s.tags)||s.tags.length>12||s.tags.some(t=>typeof t!=='string'||t.length>35)||!Array.isArray(s.sources)||!s.sources.length||s.sources.some(x=>typeof x!=='string'||!/^https:\/\//.test(x))||typeof s.requires_current_verification!=='boolean'||!Array.isArray(s.scenes)||s.scenes.length<6||s.scenes.length>10)throw new Error('El guion no cumple el esquema editorial.');
 let words=0;
 for(const [i,x] of s.scenes.entries()){for(const [key,max] of Object.entries({voice:250,screen_text:55,key_point:65,stock_query:90,formula:45})){if(typeof x[key]!=='string'||x[key].length>max)throw new Error(`Escena ${i+1}: ${key} debe ser texto de máximo ${max} caracteres (recibidos: ${typeof x[key]==='string'?x[key].length:typeof x[key]}).`);}if(!['stock','curve','formula'].includes(x.visual))throw new Error(`Escena ${i+1}: visual debe ser stock, curve o formula.`);words+=x.voice.trim().split(/\s+/).length;}
 if(words<110||words>145)throw new Error(`El guion tiene ${words} palabras narradas; debe tener entre 110 y 145.`);
 if(/[<>]/.test(s.title+s.description))throw new Error('Metadatos no válidos.');
 // Regulatory/pricing topics are not eligible for unattended production.
 let editorialText=[s.title,s.description,...s.tags,...s.scenes.flatMap(x=>[x.voice,x.screen_text,x.key_point])].join(' ');
 // Physical laws are stable concepts; source URL paths are not narrated legal claims.
 if(/ley de (ohm|faraday|joule|kirchhoff|coulomb)/i.test(editorialText)&&!/\bley\s+\d+/i.test(editorialText))editorialText=editorialText.replace(/\bley\b/gi,'principio');
 if(/\b(ley|decreto|resolución|regulaci[oó]n|normativa|precio|tarifa|licitaci[oó]n vigente|salario m[ií]nimo)\b/i.test(editorialText))s.requires_current_verification=true;
 return s;
}
async function usage(provider,limit){const r=await query("SELECT count(*)::int n FROM saas.video_factory_usage WHERE provider=$1 AND created_at>now()-interval '24 hours'",[provider]);if(r.rows[0].n>=limit)throw new Error(`Límite diario local de ${provider} alcanzado.`);await query('INSERT INTO saas.video_factory_usage(provider) VALUES($1)',[provider]);}
async function gemini(settings,prompt,responseSchema){
 // Admission and model fallback are enforced by the shared gateway.
 await query("INSERT INTO saas.video_factory_usage(provider) VALUES('gemini')");
 const r=await fetch(`http://127.0.0.1:4012/v1beta/models/${settings.model}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':decryptSecret(settings.gemini_key),'x-cernoia-service':'video-factory'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:.6,maxOutputTokens:5000,responseMimeType:'application/json',responseSchema}}),signal:AbortSignal.timeout(90000)});
 if(!r.ok)throw new Error(`Gemini HTTP ${r.status}. Revisa la clave, el modelo y el cupo gratuito.`);
 const j=await r.json();const text=j.candidates?.[0]?.content?.parts?.filter(p=>p.text).map(p=>p.text).join('')||'';
 return JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
}
async function generate(settings){
 const history=(await query('SELECT title,brand FROM saas.video_ideas ORDER BY created_at DESC LIMIT 120')).rows;const recent=history.map(x=>x.title);const nextBrand=history[0]?.brand==='nika'?'cernoia':'nika';
 const topicPrompt=`Eres editor técnico de videos educativos en español neutro. En esta ejecución debes elegir brand ${nextBrand}. Si es nika elige un concepto físico estable de electricidad o energía sin referencias regulatorias; si es cernoia explica lectura de datos o documentos sin atribuir funcionalidades específicas al producto. Elige UN tema original diferente de: ${JSON.stringify(recent)}. Alterna energías renovables, solar, electricidad, eficiencia y baterías para Energética Nika (brand nika), con lectura de oportunidades de contratación pública, documentos empresariales, análisis de datos y uso prudente de IA para CernoIA (brand cernoia). CernoIA es una plataforma privada de inteligencia del mercado público colombiano; no pertenece a SECOP. No inventes funcionalidades ni prometas adjudicaciones o ahorros. No uses precios, leyes ni información actual. Guion de 110 a 145 palabras TOTALES narradas en 8 escenas de una o dos frases cortas cada una, natural, sin saludos ni relleno. Hook inicial, ejemplo concreto y cierre educativo. Cada escena: voice texto pronunciado con números/unidades escritos para hablar sin errores; screen_text máximo 55 caracteres; key_point máximo 65; stock_query en inglés específica para buscar imágenes/clips en Pexels; visual stock, curve (solo irradiancia solar) o formula; formula vacío salvo fórmula técnicamente correcta. Título atractivo pero fiel, miniatura_text de pocas palabras (campo thumbnail_text máx 50), descripción útil sin marcas inventadas y tags relevantes. topic_key semántica breve normalizada para no repetir el concepto. Sources: URLs oficiales que permitan verificar los conceptos, no inventes citas ni datos. requires_current_verification true si no puedes evitar información reciente. Devuelve el objeto JSON del esquema.`;
 let story,correction='';
 for(let attempt=0;attempt<3;attempt++){try{
  story=await gemini(settings,topicPrompt+correction,schema);
  // Display labels can be shortened safely; narrated explanations are never truncated.
  if(Array.isArray(story?.scenes))for(const scene of story.scenes){scene.screen_text=fitCaption(scene.screen_text,55);scene.key_point=fitCaption(scene.key_point,65);}
  story.thumbnail_text=fitCaption(story.thumbnail_text,50);validateStory(story);break;
 }catch(e){console.log('[VideoFactory] Ajuste editorial:',e.message);if(attempt===2||/HTTP|Límite/.test(e.message))throw e;correction=` CORRIGE la respuesta anterior: ${e.message} Corrige el campo indicado, conserva el tema y mantén cada voice en 15–17 palabras, máximo 136 en total. Respuesta anterior: ${JSON.stringify(story||null)}`;}}
 const review=await gemini(settings,`Revisa técnicamente este guion. No certifiques datos que no puedas verificar. Busca confusiones entre potencia y energía, HSP y horas de sol, promesas comerciales, funcionalidades no confirmadas y requisitos legales. approved solo si explica conceptos estables y correctos; requires_current_verification si necesita datos actuales. Devuelve approved, requires_current_verification, reason (en español). Guion: ${JSON.stringify(story)}`,{type:'OBJECT',properties:{approved:{type:'BOOLEAN'},requires_current_verification:{type:'BOOLEAN'},reason:{type:'STRING'}},required:['approved','requires_current_verification','reason']});
 story.editorial_review=review;
 const held=story.requires_current_verification||review.approved!==true||review.requires_current_verification!==false;
 const id=`idea-${randomUUID()}`;const topicKey=createHash('sha256').update(story.topic_key.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'')).digest('hex');
 await query(`INSERT INTO saas.video_ideas(id,topic_key,brand,title,storyboard,status,scheduled_at,error) VALUES($1,$2,$3,$4,$5,$6,GREATEST($7::timestamptz,COALESCE((SELECT max(scheduled_at)+interval '3 hours' FROM saas.video_ideas WHERE status='pending'),$7::timestamptz)),$8) ON CONFLICT(topic_key) DO NOTHING`,[id,topicKey,story.brand,story.title,story,held?'held':'pending',settings.next_run,held?String(review.reason||'Requiere verificación editorial.').slice(0,1000):null]);
}
function stockURL(url){const u=new URL(url);if(u.protocol!=='https:'||!['images.pexels.com','videos.pexels.com','player.vimeo.com','player.pexels.com'].includes(u.hostname))throw new Error('El proveedor devolvió un recurso fuera de los dominios permitidos.');return u;}
async function download(url,path){
 stockURL(url);const r=await fetch(url,{signal:AbortSignal.timeout(120000),redirect:'error'});if(!r.ok)throw new Error(`Descarga Pexels HTTP ${r.status}.`);
 if(Number(r.headers.get('content-length'))>40*1024*1024)throw new Error('Recurso demasiado pesado.');
 const chunks=[];let length=0;for await(const chunk of r.body){length+=chunk.length;if(length>40*1024*1024)throw new Error('Recurso demasiado pesado.');chunks.push(chunk);}
 await writeFile(path+'.part',Buffer.concat(chunks));await rename(path+'.part',path);
}
async function resource(settings,scene,videoPreferred,orientation='portrait'){
 const key=createHash('sha256').update(scene.stock_query+(videoPreferred?'video':'photo')+(orientation==='portrait'?'':orientation)).digest('hex').slice(0,24);const manifest=`${runtimeRoot}/cache/${key}.json`;
 try{const saved=JSON.parse(await readFile(manifest,'utf8'));await stat(saved.path);saved.last_used=new Date().toISOString();await writeFile(manifest,JSON.stringify(saved));return saved;}catch{}
 const headers={Authorization:decryptSecret(settings.pexels_key)};let asset;
 if(videoPreferred){await usage('pexels',160);const r=await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(scene.stock_query)}&per_page=5&orientation=${orientation}`,{headers,signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Pexels HTTP ${r.status}.`);const j=await r.json();for(const v of j.videos||[]){const file=v.video_files?.filter(f=>f.file_type==='video/mp4'&&f.width>=480&&f.width<=1080).sort((a,b)=>Math.abs(a.width-720)-Math.abs(b.width-720))[0];if(file&&v.duration<=90){asset={provider:'Pexels',id:v.id,author:v.user.name,source:v.url,url:file.link,license:'https://www.pexels.com/license/',width:file.width,height:file.height,type:'video'};break;}}}
 if(!asset){await usage('pexels',160);const r=await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(scene.stock_query)}&per_page=5&orientation=${orientation}`,{headers,signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Pexels HTTP ${r.status}.`);const j=await r.json();const p=(orientation==='landscape'?j.photos?.find(p=>p.width>=1280&&p.height>=720):null)||j.photos?.[0];if(!p)throw new Error('Pexels no encontró recursos pertinentes. Se reintentará sin usar imágenes ajenas al tema.');asset={provider:'Pexels',id:p.id,author:p.photographer,source:p.url,url:p.src.large2x,license:'https://www.pexels.com/license/',width:p.width,height:p.height,type:'photo'};}
 asset.path=`${runtimeRoot}/cache/pexels-${asset.type}-${asset.id}.${asset.type==='video'?'mp4':'jpg'}`;
 try{await stat(asset.path);}catch{await download(asset.url,asset.path);}
 asset.last_used=new Date().toISOString();await writeFile(manifest,JSON.stringify(asset));return asset;
}
export async function render(idea,settings){
 const id=`video-${idea.id.replace('idea-','')}`;const dir=`${mediaRoot}/${id}`;await mkdir(dir,{recursive:true});
 const story={...idea.storyboard,voice:settings.voice};const assets=[];
 for(let i=0;i<story.scenes.length;i++){const a=await resource(settings,story.scenes[i],i%3===0);assets.push(a);story.scenes[i].asset_path=a.path;}
 const cover=await resource(settings,story.scenes[0],false,'landscape');assets.push(cover);story.thumbnail_path=cover.path;
 await writeFile(`${dir}/storyboard.json`,JSON.stringify(story,null,2));await writeFile(`${dir}/licenses.json`,JSON.stringify(assets,null,2));
 await new Promise((resolve,reject)=>{const child=spawn(`${runtimeRoot}/venv/bin/python`,[`${runtimeRoot}/render.py`,dir],{stdio:['ignore','pipe','pipe'],env:{...process.env,OMP_NUM_THREADS:'1'}});const timer=setTimeout(()=>child.kill('SIGTERM'),18*60*1000);let error='';child.stdout.on('data',d=>console.log(`[VideoFactory] project=${id} ${String(d).trim()}`));child.stderr.on('data',d=>{error=(error+String(d)).slice(-2000);});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Render falló (${code}): ${error.slice(-500)}`));});});
 const qc=JSON.parse(await readFile(`${dir}/qc.json`,'utf8'));const bytes=(await stat(`${dir}/video.mp4`)).size;
 const credits=[...new Set(assets.map(a=>`${a.author} / Pexels: ${a.source}`))].join('\n');
 const metadata={title:story.title,description:(story.description+'\n\nRecursos visuales: '+credits+'\nNarración sintética. Contenido educativo; no sustituye asesoría técnica o jurídica.').slice(0,4900),tags:story.tags,privacy:'private',categoryId:'27',language:'es',madeForKids:false,containsSyntheticMedia:false};
 await query("INSERT INTO saas.youtube_videos(id,metadata,script,duration_seconds,file_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",[id,metadata,story,qc.duration,bytes]);
 await query("UPDATE saas.video_ideas SET status='rendered',video_id=$2,error=NULL,updated_at=now() WHERE id=$1",[idea.id,id]);
}
async function cleanup(){
 const cutoff=Date.now()-24*3600000;const files=await readdir(`${runtimeRoot}/cache`,{withFileTypes:true});
 let bytes=await storageBytes(`${runtimeRoot}/cache`);
 for(const f of files){if(!f.isFile()||!f.name.endsWith('.json'))continue;const path=`${runtimeRoot}/cache/${f.name}`;try{const a=JSON.parse(await readFile(path,'utf8'));if(Date.parse(a.last_used)<cutoff||bytes>500*1024*1024){const size=(await stat(a.path)).size;await rm(a.path,{force:true});await rm(path,{force:true});bytes-=size;}}catch{}}
 // Keep interrupted job files for resume, but purge abandoned/failed render intermediates.
 for(const row of (await query("SELECT id FROM saas.video_ideas WHERE status IN ('cancelled','failed','deleted') AND updated_at<now()-interval '24 hours'")).rows)await rm(`${mediaRoot}/video-${row.id.replace('idea-','')}`,{recursive:true,force:true});
}
export async function cycle(){
 const lock=await pool.connect();let locked=false;
 try{
  locked=(await lock.query('SELECT pg_try_advisory_lock(760919) AS locked')).rows[0].locked;if(!locked)return;
  const s=(await query('SELECT * FROM saas.video_factory_settings WHERE id=true')).rows[0];
  await query('UPDATE saas.video_factory_settings SET heartbeat=now() WHERE id=true');
  if(!s.enabled){await query("UPDATE saas.video_factory_settings SET last_status='Producción pausada por el propietario.' WHERE id=true");return;}
  if(!s.gemini_key||!s.pexels_key||!s.free_tier_confirmed){await query("UPDATE saas.video_factory_settings SET last_status='Completa Gemini/Pexels y confirma el proyecto gratuito sin facturación.' WHERE id=true");return;}
  const disk=await statfs(mediaRoot);const available=Number((await readFile('/proc/meminfo','utf8')).match(/MemAvailable:\s+(\d+)/)[1])*1024;
  if(Number(disk.bavail)*Number(disk.bsize)<3*1024**3||await storageBytes(mediaRoot)>2*1024**3||available<650*1024**2){await query("UPDATE saas.video_factory_settings SET last_status='En espera de recursos: libera espacio o espera a que haya RAM disponible.' WHERE id=true");return;}
  await cleanup();
  // A dead renderer can be resumed safely because this process owns the exclusive lock.
  await query("UPDATE saas.video_ideas SET status='pending' WHERE status='rendering'");
  let pending=(await query("SELECT count(*)::int n FROM saas.video_ideas WHERE status='pending'")).rows[0].n;
  if(pending<6){
   await query("UPDATE saas.video_factory_settings SET last_status='Gemini está preparando temas y guiones.' WHERE id=true");
   try{await generate(s);await query("UPDATE saas.video_factory_settings SET last_error=NULL,last_status='Ideas preparadas. Esperando el próximo turno de producción.' WHERE id=true");}catch(e){if(!pending)throw e;await query('UPDATE saas.video_factory_settings SET last_error=$1 WHERE id=true',[String(e.message).slice(0,700)]);}
  }
  if(new Date(s.next_run)>new Date())return;
  const r=await query("UPDATE saas.video_ideas SET status='rendering',attempts=attempts+1,updated_at=now() WHERE id=(SELECT id FROM saas.video_ideas WHERE status='pending' AND scheduled_at<=now() ORDER BY scheduled_at LIMIT 1) RETURNING *");
  if(!r.rowCount)return;
  await query("UPDATE saas.video_factory_settings SET last_status='Produciendo video: voz, recursos, subtítulos y miniatura.' WHERE id=true");
  try{await render(r.rows[0],s);await query("UPDATE saas.video_factory_settings SET next_run=now()+interval '3 hours',last_status='Video listo. El próximo se producirá en tres horas.',last_error=NULL WHERE id=true");}
  catch(e){await query("UPDATE saas.video_ideas SET status=$2,error=$3,updated_at=now() WHERE id=$1",[r.rows[0].id,r.rows[0].attempts>=3?'failed':'pending',String(e.message).slice(0,700)]);throw e;}
 }catch(e){const message=String(e.message).replace(/AIza[\w-]+/g,'[redacted]').slice(0,700);await query("UPDATE saas.video_factory_settings SET last_error=$1,last_status='Se reintentará en el siguiente ciclo.' WHERE id=true",[message]);console.error('[VideoFactory]',message);}
 finally{if(locked)await lock.query('SELECT pg_advisory_unlock(760919)');lock.release();}
}
if(process.argv[1]?.endsWith('video-factory-worker.js')){await cycle();await pool.end();}
