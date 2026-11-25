import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider } from './llm/OpenAIProvider.js';
import { CodexCliProvider } from './llm/CodexCliProvider.js';
import { DEMO_SKILLS } from './skills/demoSkills.js';
import { executeSkillTool } from './skills/tools.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const outputDir=path.join(root,'outputs');
const app=express();
const providerMode=(process.env.LLM_PROVIDER||'codex').toLowerCase();
const provider=providerMode==='openai'?new OpenAIProvider():new CodexCliProvider();
const configuredDaily=Number.parseInt(process.env.MAX_DAILY_AI_REQUESTS||'30',10);
const maxDaily=Number.isFinite(configuredDaily)?Math.max(1,configuredDaily):30;
const usage=new Map();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));

function consume(ip){const day=new Date().toISOString().slice(0,10),prev=usage.get(ip);const entry=prev?.day===day?prev:{day,count:0};if(entry.count>=maxDaily)return false;entry.count++;usage.set(ip,entry);return true}
const fail=(res,status,error,message)=>res.status(status).json({ok:false,error,message});
const demoOnly=req=>req.body?.demoMode===true;
app.get('/api/health',(req,res)=>res.json({ok:true,provider:provider.ready?providerMode:'not_configured',model:provider.model,demoOnly:true,maxDailyRequests:maxDaily}));
app.get('/api/demo-skills',(req,res)=>res.json({skills:DEMO_SKILLS}));

app.post('/api/analyze',async(req,res)=>{
  if(!demoOnly(req))return fail(res,400,'demo_mode_required','Перед анализом подтвердите, что это учебный текст без реальных документов и данных компании.');
  const description=typeof req.body.description==='string'?req.body.description.trim():'';
  if(!description)return fail(res,400,'description_required','Напишите, чем вы занимаетесь.');
  if(description.length>6000)return fail(res,413,'too_long','Описание слишком длинное. Максимум 6000 символов.');
  if(!provider.ready)return fail(res,503,'provider_not_configured',providerMode==='openai'?'На сервере не задан OPENAI_API_KEY. Добавьте ключ в локальный .env и перезапустите сервер.':'Codex CLI не найден. Установите Codex CLI, выполните codex login и перезапустите SkillHub.');
  try{
    const existing=Array.isArray(req.body.existingSkills)?req.body.existingSkills.slice(0,20).map(s=>({id:String(s.id||'').slice(0,40),title:String(s.title||'').slice(0,120)})):[];
    const result=await provider.analyzeWork(description,existing,()=>consume(req.ip));
    res.json({ok:true,result});
  }catch(error){
    console.error('[api/analyze]',error?.status||error?.name||'error');
    if(error?.code==='LOCAL_DAILY_LIMIT')return fail(res,429,'daily_limit','Достигнут дневной лимит AI-запросов. Попробуйте завтра.');
    if(error?.code==='MODEL_REFUSAL')return fail(res,422,'model_refusal','AI не смог обработать этот текст. Измените или сократите описание и попробуйте снова.');
    if(error?.code==='MODEL_INCOMPLETE')return fail(res,502,'incomplete_response','AI вернул незавершённый ответ. Попробуйте сократить описание и повторить запрос.');
    if(error?.code==='CODEX_NOT_FOUND')return fail(res,503,'codex_not_found','Codex CLI не найден. Установите его, выполните codex login и перезапустите SkillHub.');
    if(error?.code==='CODEX_TIMEOUT')return fail(res,504,'codex_timeout','Codex CLI не ответил вовремя. Проверьте вход в Codex и подключение к интернету.');
    fail(res,502,'analysis_failed',providerMode==='openai'?'Не удалось связаться с AI-сервисом или прочитать результат. Проверьте подключение и настройки модели, затем попробуйте ещё раз.':'Codex CLI не смог выполнить анализ. Проверьте, что выполнен codex login, и повторите попытку.');
  }
});

app.post('/api/assistant',async(req,res)=>{
  if(!demoOnly(req))return fail(res,400,'demo_mode_required','Цифровой двойник работает только с учебными данными.');
  if(!provider.ready)return fail(res,503,'provider_not_configured',providerMode==='openai'?'На сервере не задан OPENAI_API_KEY.':'Codex CLI не найден. Установите Codex CLI, выполните codex login и перезапустите SkillHub.');
  const messages=Array.isArray(req.body.messages)?req.body.messages.slice(-12):[];
  if(!messages.length||messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'))return fail(res,400,'messages_required','Добавьте сообщение для цифрового двойника.');
  if(messages.reduce((n,m)=>n+m.content.length,0)>7000)return fail(res,413,'too_long','Диалог слишком длинный. Начните новый диалог.');
  // Function calls can only use an explicitly confirmed demo skill and one of the
  // three local deterministic capabilities. No client value can name a remote action.
  const allowedKinds=new Set(['purchase_check','offer_compare','supplier_table']);
  const approvedSkills=Array.isArray(req.body.approvedSkills)?req.body.approvedSkills.slice(0,20).filter(s=>s&&s.approved===true&&s.demo===true&&(s.kind==null||allowedKinds.has(s.kind))&&typeof s.id==='string').map(s=>({id:s.id.slice(0,40),kind:s.kind||null,title:String(s.title||'').slice(0,120),status:'Подтверждён сотрудником · демо'})):[];
  if(!approvedSkills.length)return fail(res,400,'no_approved_skills','Сначала подтвердите хотя бы один Skill с доступным демонстрационным действием.');
  try{
    const result=await provider.respondWithTools(messages,approvedSkills,(name,args,skills)=>executeSkillTool(name,args,skills,outputDir),()=>consume(req.ip));
    res.json({ok:true,...result});
  }catch(error){
    console.error('[api/assistant]',error?.status||error?.name||'error');
    if(error?.code==='CODEX_TIMEOUT')return fail(res,504,'codex_timeout','Codex CLI не ответил вовремя. Проверьте вход в Codex и подключение к интернету.');
    fail(res,502,'assistant_failed',providerMode==='openai'?'Цифровой двойник временно недоступен. Проверьте соединение или повторите попытку.':'Цифровой двойник временно недоступен. Проверьте, что выполнен codex login и есть подключение к интернету.');
  }
});

app.get('/api/files/:name',(req,res)=>{
  if(!/^comparison-[a-f0-9-]+\.csv$/i.test(req.params.name))return res.sendStatus(404);
  res.download(path.join(outputDir,req.params.name),req.params.name,err=>{if(err&&!res.headersSent)res.sendStatus(404)});
});
app.use('/pages',express.static(path.join(root,'pages'),{index:'index.html'}));
app.use('/assets/reference-art',express.static(path.join(root,'assets','reference-art')));
app.get('/',(req,res)=>res.sendFile(path.join(root,'index.html')));
app.get('/app.js',(req,res)=>res.sendFile(path.join(root,'app.js')));
app.get('/styles.css',(req,res)=>res.sendFile(path.join(root,'styles.css')));
app.get('/reference-pages.css',(req,res)=>res.sendFile(path.join(root,'reference-pages.css')));
app.get('/assets/landing-approved.png',(req,res)=>res.sendFile(path.join(root,'assets','landing-approved.png')));
app.use((err,req,res,next)=>{if(err instanceof SyntaxError&&'body'in err)return fail(res,400,'invalid_json','Не удалось прочитать запрос.');console.error('[server]',err?.name||'error');fail(res,500,'server_error','Внутренняя ошибка приложения.')});
const port=Number(process.env.PORT||3000);
const host=process.env.HOST||'127.0.0.1';
app.listen(port,host,()=>console.log(`SkillHub demo available at http://localhost:${port} · ${provider.ready?`${providerMode} provider found`:providerMode==='openai'?'OPENAI_API_KEY missing':'Codex CLI not found'}`));
