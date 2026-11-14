import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { browserHarness } from './support/browser.mjs';
import { pdfBytes } from './browser/pdf-region-selection-pdf.mjs';
const workspace=fileURLToPath(new URL('../../..',import.meta.url));

test('PDF crops create nested revisioned questions through the gated real core and reopen offline',async()=>{
  execFileSync('cargo',['build','-p','memnoter-core','--example','command-harness'],{cwd:workspace,env:{...process.env,CARGO_BUILD_JOBS:'4'},stdio:'pipe'});
  const child=spawn(`${workspace}/target/debug/examples/command-harness`,['--question-bank-dev'],{stdio:['pipe','pipe','inherit']});
  const pending=[]; createInterface({input:child.stdout}).on('line',line=>pending.shift()(JSON.parse(line)));
  const call=async(command,args={})=>{ const result=await new Promise(resolve=>{pending.push(resolve);child.stdin.write(JSON.stringify({command,args})+'\n');});if(result.error)throw new Error(result.error.message??result.error);return result.value; };
  const {createServer,webkit}=browserHarness(import.meta.url);let server,browser;
  try {
    const module=await call('create_module',{name:'Mechanics'});
    // Intrinsic 90-degree rotation: selection coordinates must remain in the
    // displayed page frame, rather than being rotated a second time.
    const source=pdfBytes(2,90).toString();
    const pdf=await call('add_document_bytes',{moduleId:module,name:'Mechanics.pdf',bytes:[...Buffer.from(source)]});
    server=await createServer({server:{port:0,strictPort:false},logLevel:'error'});await server.listen();
    browser=await webkit.launch(); const page=await browser.newPage({viewport:{width:1220,height:900},deviceScaleFactor:2});
    await page.exposeFunction('bankCall',async(command,args={})=>{
      if(command==='plugin:event|listen'||command==='plugin:event|unlisten')return 1;
      if(command==='resolve_card_image') {const path=await call(command,args);return 'data:image/png;base64,'+(await readFile(path)).toString('base64');}
      if(command==='document_path')return '/bank-source.pdf';
      return call(command,args);
    });
    await page.addInitScript(()=>{Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});window.installTestBridge({tauri:{invoke:(command,args)=>window.bankCall(command,args)}});});
    await page.route('**/bank-source.pdf',route=>route.fulfill({contentType:'application/pdf',body:Buffer.from(source)}));
    const url=`http://localhost:${server.httpServer.address().port}/tests/browser/question-bank.html?module=${module}&pdf=${pdf.id}`;
    await page.goto(url); await page.getByRole('button',{name:'Question bank',exact:true}).click();
    await page.getByRole('heading',{name:'Question bank',exact:true}).waitFor();
    const crop=async()=>{
      await page.getByRole('button',{name:'Crop question',exact:true}).click();
      const area=page.getByLabel('Drag a region on this PDF page').first();await area.waitFor();
      const box=await area.boundingBox();await page.mouse.move(box.x+box.width*.25,box.y+box.height*.25);await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height*.75);await page.mouse.up();
      await page.getByRole('dialog',{name:'Add PDF crop to question bank'}).waitFor();
    };
    await crop();await page.getByLabel('Question title',{exact:true}).fill('Momentum');await page.getByRole('button',{name:'Create question',exact:true}).click();
    await page.getByRole('article',{name:'Question 1',exact:true}).getByRole('img').waitFor();
    let bank=await call('question_bank_get',{moduleId:module});const qid=Object.keys(bank.questions)[0]; const first=bank.questions[qid].revisionId;
    const rev=bank.revisions[first]; const firstCrop=Object.values(rev.crops)[0];
    assert.equal(firstCrop.rotation,90);assert.equal(firstCrop.pageIndex,0);
    for(const [i,actual] of firstCrop.rect.entries())assert.ok(Math.abs(actual-[.25,.25,.5,.5][i])<.002);
    await crop();await page.getByRole('button',{name:'Add crop',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('article img').length===2);
    await crop();await page.getByRole('radio',{name:'New part…',exact:true}).check();await page.getByLabel('Part label',{exact:true}).fill('(a)');await page.getByRole('button',{name:'Create part',exact:true}).click();
    await page.getByRole('button',{name:'1(a) Crop target',exact:true}).waitFor();
    await page.getByLabel('New part label',{exact:true}).fill('(i)');await page.getByRole('button',{name:'Add part',exact:true}).click();
    await page.getByRole('button',{name:'1(a)(i) Crop target',exact:true}).waitFor();
    await crop();await page.getByRole('button',{name:'Add crop',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('article img').length===4);
    await page.getByRole('button',{name:'Move crop later',exact:true}).first().click();
    await page.getByRole('button',{name:'Remove crop',exact:true}).last().click();
    await page.waitForFunction(()=>document.querySelectorAll('article img').length===3);
    bank=await call('question_bank_get',{moduleId:module});assert.deepEqual(bank.revisions[first],rev,'published revision stays immutable');
    assert.equal(Object.keys(bank.answers).length,0,'no answer/ink stage is authored');
    await page.reload();await page.getByRole('button',{name:'Question bank',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('article img').length===3&&[...document.querySelectorAll('article img')].every(img=>img.complete&&img.naturalWidth>0));
    assert.equal(await page.getByLabel('New part label',{exact:true}).count(),0,'reload does not silently select a stale crop target');
    await page.context().setOffline(true);
    assert.equal(await page.locator('article img').evaluateAll(images=>images.every(img=>img.naturalWidth>0)),true);
    assert.ok(await call('question_bank_enabled'));await assert.rejects(call('sync_enable',{account:'no-sync'}),/cannot sync/);
  } finally {await browser?.close();await server?.close();child.stdin.end();await new Promise(resolve=>child.on('exit',resolve));}
});
