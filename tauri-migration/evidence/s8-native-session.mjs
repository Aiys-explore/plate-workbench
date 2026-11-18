import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const here=dirname(fileURLToPath(import.meta.url))
const {chromium}=createRequire(new URL('../source/package.json',import.meta.url))('playwright')
const exe=resolve(process.argv[2] ?? join(here,'../source/src-tauri/target/release/plate-workbench.exe'))
const run=await mkdtemp(join(tmpdir(),'plate-s8-native-'))
const defaultRoot=join(run,'unused-default')
const existing=join(run,'existing-workspace')
const fixtureId=randomUUID()
const route='/plate-s8-link-check/'+randomUUID()
const result={status:'pending',openExisting:false,linkOpened:false}
const server=createServer((req,res)=>{
  if(req.url!==route) return res.writeHead(404).end()
  const ua=req.headers['user-agent']??''
  result.linkOpened=/Mozilla\/5\.0/.test(ua) && !ua.includes('wv)')
  result.browserUserAgent=ua
  result.browserNavigation=req.headers['sec-fetch-mode']==='navigate'
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>Plate S8 链接验收</title><h1>Plate S8 外链跳转成功</h1>')
})
server.listen(0,'127.0.0.1')
await once(server,'listening')
const uri='http://127.0.0.1:'+server.address().port+route
await mkdir(join(existing,'projects','default'),{recursive:true})
await writeFile(join(existing,'plate-workbench.json'),JSON.stringify({version:'0.3.0-s7.0',fixture:true}))
await writeFile(join(existing,'projects','default',fixtureId+'.md'),'# S8 现场外链验证\n\n[打开验收链接]('+uri+')\n')
const port=portServer().listen(0,'127.0.0.1')
await once(port,'listening')
const debug=port.address().port
await new Promise(done=>port.close(done))
const child=spawn(exe,[],{cwd:run,windowsHide:true,stdio:'ignore',env:{...process.env,PLATE_WORKSPACE_ROOT:defaultRoot,
  WEBVIEW2_USER_DATA_FOLDER:join(run,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+debug,
}})
let page
try {
  await writeFile(join(run,'target.json'),JSON.stringify({pid:child.pid,exe,defaultRoot,existing,port:debug,uri},null,2))
  console.log('NATIVE TARGET',JSON.stringify({pid:child.pid,existing,defaultRoot,debug,run}))
  const end=Date.now()+360000
  const address='http://127.0.0.1:'+debug
  while (Date.now()<end && !await fetch(address+'/json/version').then(r=>r.ok,()=>false)) await sleep(100)
  const browser=await chromium.connectOverCDP(address)
  page=browser.contexts()[0].pages()[0]
  await page.waitForFunction(()=>!!window.workbench)
  const state=await page.evaluate(()=>window.workbench.startup.state())
  assert.equal(state.suggested,defaultRoot)
  while (Date.now()<end && child.exitCode===null) {
    const state=await page.evaluate(()=>({
      kind:document.querySelector('[data-startup-candidate]')?.getAttribute('data-startup-candidate'),
      path:document.querySelector('[data-startup-candidate]')?.textContent,
      visibleNote:!!document.querySelector('[aria-label="笔记关系图"]'),
      hasStartupError:!!document.querySelector('.p13-error'),
    })).catch(()=>null)
    if (state?.kind==='existing' && state.path===existing && !state.hasStartupError) result.selectedExisting=true
    if (state?.visibleNote) {
      const active=await page.evaluate(()=>window.workbench.startup.state())
      result.openExisting=active.path===existing
      if (result.openExisting && result.linkOpened && result.browserNavigation) {
        result.status=result.selectedExisting?'pass':'incomplete'
        break
      }
    }
    await writeFile(join(run,'progress.json'),JSON.stringify({...result,state},null,2))
    await sleep(400)
  }
} catch(error) {
  result.error=String(error.message)
  process.exitCode=1
} finally {
  await writeFile(join(run,'result.json'),JSON.stringify(result,null,2))
  if(child.exitCode===null) {
    const exited=once(child,'exit').then(()=>true)
    if(page) void page.evaluate(()=>window.workbench.startup.exit()).catch(()=>{})
    if(!await Promise.race([exited,sleep(2500,false)])){ child.kill(); await exited }
  }
  server.closeAllConnections()
  await new Promise(done=>server.close(done))
  console.log(JSON.stringify(result),join(run,'result.json'))
}
