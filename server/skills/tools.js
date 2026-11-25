import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const str = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const offerSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    supplier: str, price: { type: ['number', 'null'] }, currency: str,
    deliveryDays: { type: ['number', 'null'] }, specificationsMatch: { type: ['boolean', 'null'] },
    warrantyMonths: { type: ['number', 'null'] }
  },
  required: ['supplier', 'price', 'currency', 'deliveryDays', 'specificationsMatch', 'warrantyMonths']
};
const functionTool = (name, description, properties, required) => ({
  type: 'function', name, description, strict: true,
  parameters: { type: 'object', additionalProperties: false, properties, required }
});
export const TOOLS = [
  functionTool('validate_purchase_request', 'Run deterministic completeness and status checks for a synthetic purchase request. Never approves or submits a purchase.', {
    requestName: str, initiator: nullableString, department: nullableString, itemName: nullableString,
    quantity: { type: ['number', 'null'] }, specification: nullableString, deliveryDeadline: nullableString,
    needReason: nullableString, planStatus: { type: 'string', enum: ['included', 'not_included', 'unknown'] },
    fundingStatus: { type: 'string', enum: ['confirmed', 'pending', 'unknown'] }
  }, ['requestName','initiator','department','itemName','quantity','specification','deliveryDeadline','needReason','planStatus','fundingStatus']),
  functionTool('compare_commercial_offers', 'Compare provided synthetic commercial offers using transparent demo ordering: specification match first, then lower price, then faster delivery. Does not make a purchasing decision.', {
    offers: { type: 'array', items: offerSchema }
  }, ['offers']),
  functionTool('create_supplier_comparison', 'Generate a downloadable CSV comparison from the exact offer data supplied. Use after comparing offers or when a comparative table is requested.', {
    title: str, offers: { type: 'array', items: offerSchema }
  }, ['title','offers'])
];

const nullable = v => v === null || v === '' || v === undefined;
export function validatePurchaseRequest(a) {
  const missing = [];
  for (const [k,label] of [['initiator','инициатор'],['department','подразделение'],['itemName','наименование'],['quantity','количество'],['specification','характеристики / спецификация'],['deliveryDeadline','сроки'],['needReason','обоснование потребности']]) if (nullable(a[k])) missing.push(label);
  const issues = [];
  if (missing.length) issues.push(`Недостающие сведения: ${missing.join(', ')}.`);
  if (a.planStatus === 'not_included') issues.push('Входные данные указывают, что закупки нет в плане: требуется дополнительное согласование.');
  else if (a.planStatus === 'unknown') issues.push('Статус плана закупок не указан.');
  if (a.fundingStatus === 'pending') issues.push('Подтверждение финансирования ожидается.');
  else if (a.fundingStatus === 'unknown') issues.push('Подтверждение финансирования не указано.');
  const status = missing.length ? 'Нужны уточнения' : a.planStatus === 'not_included' ? 'Нужно дополнительное согласование' : a.fundingStatus !== 'confirmed' ? 'Ожидается подтверждение финансирования' : 'Проверки пройдены';
  return { ok:true, operation:'Проверка заявки (демо)', requestName:a.requestName, status, missing, issues, checks:{ requiredFields:missing.length===0, plan:a.planStatus, funding:a.fundingStatus }, nextAction:status==='Проверки пройдены'?'Передать на следующий этап после ручной проверки сотрудником.':'Зафиксировать замечания и запросить уточнение или согласование.', humanConfirmationRequired:true, note:'Результат основан только на введённых демонстрационных данных; это не утверждение заявки и не официальный регламент.' };
}

export function compareCommercialOffers(offers) {
  if (!Array.isArray(offers) || offers.length < 2) throw new Error('Для сравнения укажите минимум два предложения.');
  const normalized = offers.map((o,i)=>({ supplier:o.supplier||`Поставщик ${i+1}`, price:Number.isFinite(o.price)?o.price:null, currency:o.currency||'не указана', deliveryDays:Number.isFinite(o.deliveryDays)?o.deliveryDays:null, specificationsMatch:o.specificationsMatch, warrantyMonths:Number.isFinite(o.warrantyMonths)?o.warrantyMonths:null }));
  const sorted = normalized.slice().sort((a,b)=>{
    const aEligible=a.specificationsMatch===true,bEligible=b.specificationsMatch===true;
    if(aEligible!==bEligible)return aEligible?-1:1;
    if(a.price===null||b.price===null){if(a.price===null&&b.price!==null)return 1;if(a.price!==null&&b.price===null)return -1;}
    else if(a.price!==b.price)return a.price-b.price;
    return (a.deliveryDays??Infinity)-(b.deliveryDays??Infinity);
  }).map((o,i)=>({...o,rank:i+1,eligible:o.specificationsMatch===true,reason:o.specificationsMatch!==true?'Соответствие требованиям не подтверждено':i===0?'Соответствует по указанным данным; минимальная цена среди соответствующих предложений.':'Соответствует; место определяется ценой, затем сроком поставки.'}));
  return { ok:true, rows:sorted, method:'Демонстрационная сортировка: соответствие спецификации → меньшая цена → меньший срок. Никакие веса или корпоративные правила не предполагаются.', humanConfirmationRequired:true };
}

const csvCell=v=>`"${String(v??'').replaceAll('"','""')}"`;
export async function createSupplierComparison(title, offers, outputDir=path.resolve('outputs')) {
  const comparison=compareCommercialOffers(offers);
  await mkdir(outputDir,{recursive:true});
  const name=`comparison-${randomUUID()}.csv`, filePath=path.join(outputDir,name);
  const headers=['Место','Поставщик','Цена','Валюта','Срок (дней)','Соответствие спецификации','Гарантия (мес.)','Причина'];
  const rows=comparison.rows.map(r=>[r.rank,r.supplier,r.price,r.currency,r.deliveryDays,r.specificationsMatch===null?'не указано':r.specificationsMatch?'да':'нет',r.warrantyMonths,r.reason]);
  const csv='\uFEFF'+[title,...[headers,...rows].map(row=>row.map(csvCell).join(';'))].join('\r\n');
  await writeFile(filePath,csv,{encoding:'utf8',flag:'wx'});
  return {...comparison, file:{name,title,url:`/api/files/${name}`},operation:'CSV-файл действительно создан на сервере из переданных данных.'};
}

export async function executeSkillTool(name,args,approvedSkills,outputDir) {
  const skill = approvedSkills.find(s=>s.id===args.skillId);
  if (!skill) throw new Error('Операция доступна только для навыка, подтверждённого сотрудником в этой демо-сессии.');
  if (name==='validate_purchase_request' && skill.kind==='purchase_check') return validatePurchaseRequest(args);
  if (name==='compare_commercial_offers' && skill.kind==='offer_compare') return compareCommercialOffers(args.offers);
  if (name==='create_supplier_comparison' && skill.kind==='supplier_table') return createSupplierComparison(args.title,args.offers,outputDir);
  throw new Error('Выбранный Skill не разрешает эту демонстрационную функцию.');
}

// Add the approved Skill ID as a required, server-validated argument to each function.
for (const tool of TOOLS) {
  tool.parameters.properties.skillId=str;
  tool.parameters.required.unshift('skillId');
}
