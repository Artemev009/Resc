import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
await mkdir('docs',{recursive:true});
for(const name of ['index.html','app.js','styles.css','reference-pages.css']){
 let text=await readFile(name,'utf8');
 text=text.replaceAll('/assets/','./assets/').replaceAll('/examples/offers/','./examples/offers/').replaceAll('href="/reference-pages.css"','href="./reference-pages.css"');
 if(name==='index.html')text=text.replace('<script src="./app.js"','<script src="./static-preview.js"></script>\n  <script src="./app.js"');
 await writeFile(`docs/${name}`,text);
}
await cp('assets','docs/assets',{recursive:true});
await cp('scripts/static-preview.js','docs/static-preview.js');
await cp('examples/commercial-offers','docs/examples/offers',{recursive:true});
await writeFile('docs/.nojekyll','');
console.log('GitHub Pages preview built in docs/');
