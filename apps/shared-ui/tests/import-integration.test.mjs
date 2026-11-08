import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "vite";
import { webkit } from "playwright";
import { realPath, readFolder, synthetic } from "./support/import-fixture.mjs";
let server, browser, page, child;
const cacheDir = mkdtempSync(join(tmpdir(), "memnoter-import-vite-"));
const pending = [];
before(async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const workspace = fileURLToPath(new URL("../../..", import.meta.url));
  execFileSync("cargo", ["build", "-p", "memnoter-core", "--example", "command-harness"], { cwd: workspace, stdio: "pipe" });
  child = spawn(`${workspace}/target/debug/examples/command-harness`, [], { stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", line => pending.shift()(JSON.parse(line)));
  server = await createServer({ root, cacheDir, configFile: `${root}/vite.config.ts`, server: {port:0, strictPort:false}, logLevel:"error" });
  await server.listen();
  browser = await webkit.launch(); page = await browser.newPage({ viewport: { width: 1150, height: 850 } });
  await page.exposeFunction("rustCall", async (command, args = {}) => {
    const response = await new Promise(resolve => { pending.push(resolve); child.stdin.write(JSON.stringify({command,args})+"\n"); });
    if (response.error) throw new Error(response.error);
    return response.value;
  });
  await page.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.rustCall(command,args), convertFileSrc: path => path }; });
  page.on("pageerror", error => console.error("Browser:", error));
  await page.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/tables.html`);
  await page.waitForFunction(()=>!!window.editor);
});
after(async () => {
  await browser?.close(); await server?.close();
  if(child) { child.stdin.end(); await new Promise(resolve=>child.on("exit",resolve)); }
  rmSync(cacheDir, {recursive:true,force:true});
});
async function paste(source) {
  await page.evaluate(source => {
    editor.commands.focus();
    const clipboardData = new DataTransfer(); clipboardData.setData("text/plain",source);
    editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles:true, cancelable:true }));
  }, source);
}
test("Markdown tables and yellow highlights survive collaboration, one paste undo, cloze and combined toolbar", async () => {
  await page.evaluate(()=>{editor.commands.setContent("<p>before</p>");editor.commands.setTextSelection(7);stopCapture();});
  await paste("\n\n| Header |\n|---|\n| ==yellow== |\n\n==outside==");
  assert.equal(await page.locator("table").count(),1);
  assert.equal(await page.locator('mark[data-color="yellow"]').count(),2);
  assert.equal(await page.evaluate(()=>{const clone=cloneEditor();const equal=JSON.stringify(clone.editor.getJSON())===JSON.stringify(editor.getJSON());clone.editor.destroy();clone.document.destroy();return equal;}),true);
  await page.evaluate(()=>editor.commands.undo());
  assert.equal(await page.evaluate(()=>editor.getText()),"before");
  await page.evaluate(()=>editor.commands.redo());
  await page.evaluate(()=>{
    let from;editor.state.doc.descendants((node,pos)=>{if(node.isText && node.text==="yellow")from=pos;});
    editor.commands.setTextSelection({from,to:from+6});editor.commands.makeCloze();editor.commands.focus();
  });
  assert.equal(await page.evaluate(()=>{let found=false;editor.state.doc.descendants(n=>{if(n.type.name==="tableCell" && n.textContent.includes("{{yellow}}"))n.descendants(t=>{if(t.isText && t.text.includes("yellow") && t.marks.some(m=>m.type.name==="highlight"))found=true;});});return found;}),true);
  assert.ok(await page.evaluate(()=>editor.getText().includes("{{yellow}}")));
  await page.evaluate(()=>{let from;editor.state.doc.descendants((n,p)=>{if(n.isText && n.text.includes("yellow"))from=p+n.text.indexOf("yellow");});editor.commands.setTextSelection({from,to:from+6});editor.commands.focus();});
  await page.getByRole("toolbar",{name:"Text formatting"}).waitFor();
  await page.getByRole("button",{name:"Highlight",exact:true}).waitFor();
  await page.getByRole("button",{name:"Add row below",exact:true}).waitFor();
  const boxes=await page.getByRole("toolbar",{name:"Text formatting"}).evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};});
  assert.ok(boxes.left>=0 && boxes.right<=boxes.width);
});
test("real import uses Rust storage, renders with the editor schema and opening is lossless", {skip:!existsSync(realPath)}, async()=>{
  const folder=readFolder(realPath);
  const result=await page.evaluate(async folder=>{
    const result=await importFolder(folder,()=>{});
    return {moduleId:result.moduleId, notes:result.notes.length};
  },folder);
  assert.equal(result.notes,22);
  const rendered=await page.evaluate(async ({moduleId})=>{
    const saved=await call("get_content",{moduleId});
    return await loadImported(saved);
  },result);
  assert.equal(rendered.highlights,31);assert.equal(rendered.images,7);assert.equal(rendered.codeBlocks,213);assert.equal(rendered.changed,false);
  const scratch="/private/tmp/claude-501/-Users-vladyslavnalyvaiko-Projects-notes/69f196ab-6613-4071-9e30-88a843fe3ef0/scratchpad";
  mkdirSync(scratch,{recursive:true});
  await page.evaluate(() => { editor.view.dom.closest("#root").firstElementChild.style.display = "none"; document.querySelectorAll('[role="toolbar"]').forEach(el=>el.style.display="none"); window.scrollTo(0,0); });
  await page.screenshot({path:`${scratch}/imported-module.png`});
  writeFileSync(`${scratch}/import-report.json`,JSON.stringify({...result,...rendered,skipped:folder.entries.filter(e=>!e.text && !e.bytes).map(e=>e.path)},null,2));
  const stored=await page.evaluate(async ({moduleId})=>{const content=await call("get_content",{moduleId});return {files:content.files.length,updates:content.updates.length};},result);
  assert.equal(stored.files,7);assert.equal(stored.updates,0);
});
test("failed import removes its partial module and uploaded files; names get numeric suffixes", async()=>{
  const result=await page.evaluate(async folder=>{
    const first=await importFolder(folder,()=>{}),second=await importFolder(folder,()=>{});
    const broken=structuredClone(folder);broken.entries.push({path:"missing.png"});broken.entries.find(e=>e.path==="Week 10.md").text="![[missing.png]]";
    let failed=false;try{await importFolder(broken,()=>{});}catch{failed=true;}
    const modules=await call("modules");
    return {name:second.name,failed,names:modules.map(m=>m.name)};
  },synthetic);
  assert.equal(result.name,"Course 2");assert.equal(result.failed,true);assert.ok(!result.names.includes("Course 3"));
});

for (const discard of [false, true]) {
  test(`${discard ? 'restore' : 'quit'} drains an admitted import and rejects imports while exclusive`, async () => {
    const result = await page.evaluate(async ({ folder, discard }) => {
      const { exclusiveWrite } = await import('/src/lib/write-lifecycle.ts');
      const original = window.__TAURI_INTERNALS__.invoke;
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'modules') { entered(); await gate; }
        return original(command, args);
      };
      let finishExclusive, enteredExclusive;
      const exclusiveGate = new Promise(resolve => { finishExclusive = resolve; });
      const exclusiveStarted = new Promise(resolve => { enteredExclusive = resolve; });
      let drained = false, blocked = false, overlap = false;
      const importing = importFolder(folder, () => {});
      await started;
      const exclusive = exclusiveWrite(async () => {
        drained = true;
        enteredExclusive();
        await exclusiveGate;
      }, { discard });
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        overlap = drained;
      } finally { release(); }
      try {
        await importing;
        await exclusiveStarted;
        try { await importFolder(folder, () => {}); } catch (error) { blocked = /suspended/.test(String(error)); }
        finishExclusive();
        await exclusive;
      }
      finally { finishExclusive(); window.__TAURI_INTERNALS__.invoke = original; }
      return { overlap, drained, blocked };
    }, { folder: { ...synthetic, name: `Lifecycle ${discard}` }, discard });
    assert.deepEqual(result, { overlap: false, drained: true, blocked: true });
  });
}

for (const stage of ['modules', 'import_module']) {
  test(`import failure at ${stage} leaves neither a module nor image files`, async () => {
    const dir = join(tmpdir(), `memnoter-harness-${child.pid}`, 'files');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir).sort();
    const result = await page.evaluate(async ({ folder, stage }) => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === stage) throw new Error('injected failure');
        return original(command, args);
      };
      let failed = false;
      try {
        await importFolder(folder, message => { if (message === stage) throw new Error('injected failure'); });
      } catch { failed = true; }
      finally { window.__TAURI_INTERNALS__.invoke = original; }
      return { failed, modules: await call('modules') };
    }, { folder: { ...synthetic, name: `Failure ${stage}` }, stage });
    assert.equal(result.failed, true);
    assert.ok(!result.modules.some(m => m.name === `Failure ${stage}`));
    assert.deepEqual(readdirSync(dir).sort(), files);
  });
}

for (const stage of ['get_content', 'index_note']) {
  test(`post-commit ${stage} failure retains the imported module and reports retry`, async () => {
    const result = await page.evaluate(async ({ folder, stage }) => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (command === stage) throw new Error('injected index failure');
        return original(command, args);
      };
      try {
        const result = await importFolder(folder, () => {});
        return { warning: result.indexingWarning, retained: (await call('modules')).some(m => m.id === result.moduleId) };
      } finally { window.__TAURI_INTERNALS__.invoke = original; }
    }, { folder: { ...synthetic, name: `Index retry ${stage}` }, stage });
    assert.deepEqual(result, { warning: 'Imported; search indexing will retry', retained: true });
  });
}

test("sidebar dropdown leads to a configurable import dialog and commits only on Import", async () => {
  const ui = await browser.newPage();
  const calls = [];
  const imageRequests = [];
  await ui.exposeFunction('rustCall', async (command, args = {}) => {
    calls.push(command);
    if (command === 'read_import_images') { imageRequests.push(...args.images); return args.images.map(() => [137,80,78,71]); }
    if (command === 'pick_import_folder') return {
      name: 'Dialog vault', entries: [{path:'a.md',text:'## Module Info\n\n## Aims\n\n![[pic.png]]'}, {path:'b.md',text:'B'}, {path:'c.md',text:'C'}, {path:'slides.pdf'}],
    };
    // Slow enough to observe the dialog while the folder is scanned.
    if (command === 'pick_import_image_folder') return new Promise(resolve => setTimeout(resolve, 600)).then(() => ({ name: 'Images', entries: [{path:'pic.png',sourceId:'extra'}, {path:'unused.png',sourceId:'extra'}] }));
    const response = await new Promise(resolve => { pending.push(resolve); child.stdin.write(JSON.stringify({command,args})+'\n'); });
    if (response.error) throw new Error(response.error);
    return response.value;
  });
  await ui.addInitScript(() => { window.__TAURI_INTERNALS__ = { invoke: (command,args) => window.rustCall(command,args), convertFileSrc: path => path }; });
  try {
    await ui.goto(`http://localhost:${server.httpServer.address().port}/tests/browser/import-dialog.html`);
    await ui.locator('.group').first().hover();
    await ui.getByRole('button', { name: 'Add module', exact: true }).click();
    await ui.getByRole('menuitem', {name:'New module',exact:true}).click();
    await ui.getByRole('heading',{name:'Create new module'}).waitFor();
    assert.equal(await ui.getByRole('button',{name:'Import folder…',exact:true}).count(),0);
    await ui.getByRole('button',{name:'Cancel',exact:true}).click();
    await ui.locator('.group').first().hover();
    await ui.getByRole('button',{name:'Add module',exact:true}).click();
    await ui.getByRole('menuitem',{name:'Import folder…',exact:true}).click();
    await ui.getByLabel('Module name', {exact:false}).fill('Planned module');
    await ui.getByRole('button',{name:'Next',exact:true}).click();
    await ui.getByRole('button',{name:'Reorder b',exact:true}).focus();
    await ui.keyboard.press('Space'); await ui.keyboard.press('ArrowUp'); await ui.keyboard.press('Enter');
    await ui.getByRole('checkbox',{name:'c',exact:true}).uncheck();
    await ui.getByRole('button',{name:'Next',exact:true}).click();
    await ui.getByText('0 of 1 image found. 1 is missing.').waitFor();
    await ui.getByRole('button',{name:'Look in another folder…',exact:true}).click();
    await ui.getByRole('button',{name:'Scanning folder…'}).waitFor();
    assert.ok(await ui.getByRole('button',{name:'Next',exact:true}).isDisabled());
    await ui.getByText('1 image found.').waitFor();
    await ui.getByText('Using Images (2 images): found 1 missing image.', { exact: false }).waitFor();
    assert.ok(await ui.getByRole('button',{name:'Choose a different folder…',exact:true}).isVisible());
    assert.ok(!calls.includes('import_module'));
    await ui.getByRole('button',{name:'Next',exact:true}).click();
    await ui.getByRole('button',{name:'Import',exact:true}).click();
    await ui.getByText('Opened imported module').waitFor();
    await ui.getByText('Imported 2 notes and 1 image into Planned module.').waitFor();
    await ui.getByRole('dialog').waitFor({ state: 'hidden' });
    const stored = await ui.evaluate(async () => window.rustCall('modules'));
    assert.ok(stored.some(m => m.name === 'Planned module'));
    assert.deepEqual(imageRequests, [{sourceId:'extra',path:'pic.png'}]);
  } finally { await ui.close(); }
});
