import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

function unavailable(){const e=new Error('Configure a privately owned DOCX template');e.statusCode=503;return e;}
export async function renderDocx(type,bundle={}){
  if (!['fc1','fc10','garantes'].includes(type)) {const e=new Error('Unsupported document type');e.statusCode=404;throw e;}
  const dir=process.env.PRIVATE_TEMPLATE_DIR;
  if (!dir) throw unavailable();
  const xmlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  let source;
  try{source=await fs.readFile(path.join(path.resolve(dir),`${type}.docx`));}catch(e){if(e.code==='ENOENT')throw unavailable();throw e;}
  const zip=await JSZip.loadAsync(source);
  const values={};
  for(const section of ['reservation','operation']){
    for(const [key,value] of Object.entries(bundle[section]||{})) values[`${section}.${key}`]=value;
  }
  for(const [name,file] of Object.entries(zip.files)){
    if(!name.startsWith('word/')||!name.endsWith('.xml'))continue;
    const xml=(await file.async('string')).replace(/\{\{([a-z_]+\.[a-z_]+)\}\}/gi,(_,key)=>xmlEscape(values[key]));
    zip.file(name,xml);
  }
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export async function renderPdfFromDocx(){const e=new Error('Configure a private DOCX to PDF integration');e.statusCode=503;throw e;}
