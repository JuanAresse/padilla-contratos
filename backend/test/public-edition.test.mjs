import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeDniText,hasUsefulDniFields,validateArgentineCuil} from '../src/dni-ocr.mjs';
import {renderDocx,renderPdfFromDocx} from '../src/docx-generators.mjs';
import {renderPdf} from '../src/pdf-generators.mjs';
import {createOperatorAccess} from '../src/operator-auth.mjs';
import {randomBytes} from 'node:crypto';

test('empty OCR input does not invent identity fields',()=>{
  const result=analyzeDniText('');
  assert.equal(hasUsefulDniFields(result.fields),false);
  assert.equal(validateArgentineCuil(''),false);
});

test('DOCX fails explicitly when a private template is absent',async()=>{
  const old=process.env.PRIVATE_TEMPLATE_DIR;
  delete process.env.PRIVATE_TEMPLATE_DIR;
  try{await assert.rejects(()=>renderDocx('fc1'),e=>e.statusCode===503);}
  finally{if(old!==undefined)process.env.PRIVATE_TEMPLATE_DIR=old;}
});

test('unsupported template types are rejected before filesystem access',async()=>{
  await assert.rejects(()=>renderDocx('../'),e=>e.statusCode===404);
});

test('excluded PDF integrations fail with a clear status',async()=>{
  await assert.rejects(()=>renderPdf(),e=>e.statusCode===503);
  await assert.rejects(()=>renderPdfFromDocx(),e=>e.statusCode===503);
});

test('operator reads and updates require locally configured credentials',()=>{
  const username=randomBytes(12).toString('hex');
  const password=randomBytes(24).toString('hex');
  const middleware=createOperatorAccess({username,password});
  for(const [method,path] of [['GET','/api/properties'],['PUT','/api/reservations/operation'],['GET','/operador.html']]){
    let status;let passed=false;
    const response={setHeader(){},status(code){status=code;return this;},json(){return this;}};
    middleware({method,path,headers:{}},response,()=>{passed=true;});
    assert.equal(status,401);assert.equal(passed,false);
    middleware({method,path,headers:{authorization:'Basic '+Buffer.from(username+':'+password).toString('base64')}},response,()=>{passed=true;});
    assert.equal(passed,true);
  }
});

test('participant submission routes and static resources remain accessible',()=>{
  const middleware=createOperatorAccess({username:randomBytes(12).toString('hex'),password:randomBytes(24).toString('hex')});
  for(const [method,path] of [['POST','/api/reservations'],['POST','/api/guarantors'],['GET','/locatario.html'],['GET','/app.js']]){
    let passed=false;
    middleware({method,path,headers:{}},{},()=>{passed=true;});
    assert.equal(passed,true);
  }
});
