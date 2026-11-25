import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIProvider } from './llm/OpenAIProvider.js';
import { CodexCliProvider } from './llm/CodexCliProvider.js';
import { DEMO_SKILLS } from './skills/demoSkills.js';
import { executeSkillTool } from './skills/tools.js';
import { evaluateOfferReview, extractOfferText } from './skills/offerReview.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const outputDir=path.join(root,'outputs');
const app=express();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:8,fields:12,fieldSize:12000}});
const providerMode=(process.env.LLM_PROVIDER||'codex').toLowerCase();
const provider=providerMode==='openai'?new OpenAIProvider():new CodexCliProvider();
const configuredDaily=Number.parseInt(process.env.MAX_DAILY_AI_REQUESTS||'30',10);
const maxDaily=Number.isFinite(configuredDaily)?Math.max(1,configuredDaily):30;
const usage=new Map();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));

function consume(ip){const day=new Date().toISOString().slice(0,10),prev=usage.get(ip);const entry=prev?.day===day?prev:{day,count:0};if(entry.count>=maxDaily)return false;entry.count++;usage.set(ip,entry);return true}
const fail=(res,status,error,message)=>res.status(status).json({ok:false,error,message});
const demoOnly=req=>req.body?.demoMode===true||req.body?.demoMode==='true';
app.get('/api/health',(req,res)=>res.json({ok:true,provider:provider.ready?providerMode:'not_configured',model:provider.model,demoOnly:true,maxDailyRequests:maxDaily}));
app.get('/api/demo-skills',(req,res)=>res.json({skills:DEMO_SKILLS}));

app.post('/api/offer-review',upload.array('files',8),async(req,res)=>{
  if(!demoOnly(req))return fail(res,400,'demo_mode_required','В этом прототипе можно проверять только учебные предложения.');
  if(!provider.ready)return fail(res,503,'provider_not_configured',providerMode==='openai'?'На сервере не задан OPENAI_API_KEY.':'Codex CLI не найден. Выполните codex login и перезапустите SkillHub.');
  if(!Array.isArray(req.files)||req.files.length<2)return fail(res,400,'files_required','Загрузите минимум два учебных файла с предложениями.');
  let submittedSkill;
  try{submittedSkill=JSON.parse(String(req.body.skillContext||''))}catch{return fail(res,400,'skill_required','Выберите подтверждённый навык сравнения.')}
  if(!submittedSkill||typeof submittedSkill.id!=='string'||!submittedSkill.id||!String(submittedSkill.title||'').trim()||submittedSkill.kind!=='offer_compare'||submittedSkill.approved!==true||submittedSkill.demo!==true)return fail(res,400,'skill_required','Выберите подтверждённый навык сравнения.');
  const skillContext={id:submittedSkill.id.slice(0,40),title:String(submittedSkill.title).slice(0,120),purpose:String(submittedSkill.purpose||'').slice(0,500)};
  for(const key of ['inputs','steps','decisions','exceptions','allowedAutomation'])skillContext[key]=Array.isArray(submittedSkill[key])?submittedSkill[key].slice(0,20).map(item=>String(typeof item==='string'?item:item?.statement||'').slice(0,300)).filter(Boolean):[];
  const requirements={
    productName:String(req.body.productName||'').trim().slice(0,160),
    quantity:Number(req.body.quantity),
    specification:String(req.body.specification||'').trim().slice(0,1500),
    currency:String(req.body.currency||'RUB').trim().slice(0,20),
    maxDeliveryDays:req.body.maxDeliveryDays===''||req.body.maxDeliveryDays==null?null:Number(req.body.maxDeliveryDays),
    minWarrantyMonths:req.body.minWarrantyMonths===''||req.body.minWarrantyMonths==null?null:Number(req.body.minWarrantyMonths)
  };
  if(!requirements.productName||!Number.isFinite(requirements.quantity)||requirements.quantity<1||!requirements.specification)return fail(res,400,'requirements_required','Укажите предмет закупки, количество и обязательные характеристики.');
  if((requirements.maxDeliveryDays!==null&&!Number.isFinite(requirements.maxDeliveryDays))||(requirements.minWarrantyMonths!==null&&!Number.isFinite(requirements.minWarrantyMonths)))return fail(res,400,'invalid_requirement','Проверьте максимальный срок поставки и минимальную гарантию.');
  try{
    const documents=[];let totalChars=0;
    for(const file of req.files){const doc=await extractOfferText(file);totalChars+=doc.text.length;if(totalChars>30000)return fail(res,413,'documents_too_long','В извлечённых документах слишком много текста. Загрузите меньше файлов или сократите документы.');documents.push(doc)}
    const extraction=await provider.reviewCommercialOffers(requirements,documents,skillContext,()=>consume(req.ip));
    const extracted=Array.isArray(extraction?.offers)?extraction.offers:[];
    const byName=new Map(extracted.map(item=>[String(item.fileName||'').toLocaleLowerCase('ru-RU'),item]));
    const ordered=documents.map(doc=>{
      const offer=byName.get(doc.fileName.toLocaleLowerCase('ru-RU'))||({fileName:doc.fileName,unknowns:['AI не вернул сведения для этого файла.'],specificationAssessment:'unclear'});
      // This only detects a printed signatory field; it does not validate an actual signature.
      if(/(?:подписант\s*:|подпись\s*[:—-]\s*\S|электронная подпись)/i.test(doc.text))offer.signaturePresent=true;
      return offer;
    });
    res.json({ok:true,result:evaluateOfferReview(requirements,ordered)});
  }catch(error){
    console.error('[api/offer-review]',error?.status||error?.name||'error');
    if(error?.code==='LOCAL_DAILY_LIMIT')return fail(res,429,'daily_limit','Достигнут дневной лимит AI-запросов. Попробуйте позже.');
    if(error?.code==='CODEX_TIMEOUT')return fail(res,504,'codex_timeout','AI не ответил вовремя. Проверьте интернет и попробуйте снова.');
    fail(res,502,'offer_review_failed','Не удалось прочитать или проверить учебные предложения. Проверьте файлы и попробуйте снова.');
  }
});

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
  const approvedSkills=Array.isArray(req.body.approvedSkills)?req.body.approvedSkills.slice(0,20).filter(s=>s&&s.approved===true&&s.demo===true&&(s.kind==null||allowedKinds.has(s.kind))&&typeof s.id==='string').map(s=>{
    const skill={id:s.id.slice(0,40),kind:s.kind||null,title:String(s.title||'').slice(0,120),purpose:String(s.purpose||'').slice(0,500),status:'Подтверждён сотрудником · демо',approved:true,demo:true};
    for(const key of ['inputs','steps','decisions','exceptions','allowedAutomation','unknowns'])skill[key]=Array.isArray(s[key])?s[key].slice(0,20).map(item=>String(typeof item==='string'?item:item?.statement||'').slice(0,300)).filter(Boolean):[];
    const result=s.expectedResult;skill.expectedResult=String(typeof result==='string'?result:result?.statement||'').slice(0,500);
    return skill;
  }):[];
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
app.use('/examples/offers',express.static(path.join(root,'examples','commercial-offers')));
app.get('/',(req,res)=>res.sendFile(path.join(root,'index.html')));
app.get('/app.js',(req,res)=>res.sendFile(path.join(root,'app.js')));
app.get('/styles.css',(req,res)=>res.sendFile(path.join(root,'styles.css')));
app.get('/reference-pages.css',(req,res)=>res.sendFile(path.join(root,'reference-pages.css')));
app.get('/assets/landing-approved.png',(req,res)=>res.sendFile(path.join(root,'assets','landing-approved.png')));
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError)return fail(res,err.code==='LIMIT_FILE_SIZE'||err.code==='LIMIT_FILE_COUNT'?413:400,'upload_error',err.code==='LIMIT_FILE_SIZE'?'Файл больше 8 МБ.':'Не удалось принять файлы. Проверьте количество и попробуйте снова.');if(err instanceof SyntaxError&&'body'in err)return fail(res,400,'invalid_json','Не удалось прочитать запрос.');console.error('[server]',err?.name||'error');fail(res,500,'server_error','Внутренняя ошибка приложения.')});
const port=Number(process.env.PORT||3000);
const host=process.env.HOST||'127.0.0.1';
app.listen(port,host,()=>console.log(`SkillHub demo available at http://localhost:${port} · ${provider.ready?`${providerMode} provider found`:providerMode==='openai'?'OPENAI_API_KEY missing':'Codex CLI not found'}`));
