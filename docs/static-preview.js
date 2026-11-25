// Public preview: no backend requests or AI execution.
const previewMessage='Версия для просмотра: AI доступен только в локальном приложении.';
const realFetch=window.fetch.bind(window);
window.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 if(url.pathname.includes('/api/'))return Promise.resolve(new Response(JSON.stringify({ok:false,message:previewMessage}),{status:503,headers:{'Content-Type':'application/json'}}));
 return realFetch(input,options);
};
document.addEventListener('click',event=>{
 if(event.target.closest('[data-action="analyze"],[data-action="run-skill"],#offer-review-submit,#chat-form button[type="submit"]')){
  event.preventDefault();event.stopImmediatePropagation();
 }
},true);
document.addEventListener('submit',event=>{
 if(['chat-form','offer-review-form'].includes(event.target.id)){event.preventDefault();event.stopImmediatePropagation();}
},true);
function updatePreview(){
 if(!document.querySelector('#public-preview-banner')){
  const banner=document.createElement('div');banner.id='public-preview-banner';banner.textContent='SkillHub · публичный просмотр. AI и проверка файлов работают в локальной версии.';
  banner.style.cssText='position:fixed;bottom:0;left:0;right:0;padding:9px 16px;background:#33235e;color:white;text-align:center;font:13px sans-serif;z-index:9999;pointer-events:none';document.body.append(banner);
 }
 document.querySelectorAll('[data-action="analyze"],[data-action="run-skill"],#offer-review-submit,#chat-form button[type="submit"]').forEach(button=>{button.disabled=true;button.title=previewMessage;});
 const status=document.querySelector('#api-status');if(status&&status.textContent!==previewMessage)status.textContent=previewMessage;
}
document.addEventListener('DOMContentLoaded',()=>{updatePreview();new MutationObserver(updatePreview).observe(document.querySelector('#app'),{childList:true,subtree:true});});
