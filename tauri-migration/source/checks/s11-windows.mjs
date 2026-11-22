import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const source = resolve(import.meta.dirname,'..')
const packaged = process.argv.includes('--packaged')
const temporary = await realpath(tmpdir())
const sandbox = await mkdtemp(join(temporary,'plate-s11-check-'))
const workspace = join(sandbox,'workspace')
const files = join(sandbox,'allowed-files')
const existing = join(files,'export.txt')
const script = join(sandbox,'guard.rhai')
const legacyId = randomUUID()
const key = 's11-fixture-' + randomUUID()
await mkdir(join(workspace,'projects','default'),{ recursive:true })
await mkdir(files)
await writeFile(join(workspace,'plate-workbench.json'),'{"version":"0.6.0-s10.1"}')
await writeFile(join(workspace,'projects','default',legacyId+'.md'),'# Legacy learning note\n\nLEARNING_MARKER\n')
await writeFile(join(files,'AGENTS.md'),'AUTHORIZED_RULE_MARKER')
await writeFile(existing,'original file\n')
const denyScript = 'if hook.subject == "propose_file_write" { #{ allow:false, reason:"FIXTURE_FILE_REVIEW_REQUIRED" } } else { #{} }'
await writeFile(script,denyScript)

let targetNote, providerId, browser, page, app, vite
const requests = []
const checks = []
const errors = []
let maxEvals = 0
let evals = 0
const mcpCalls = []
const mcpSessions = new Set()
const usage = { prompt_tokens:40, completion_tokens:10 }
function completion(response,delta,reason='stop') {
  response.writeHead(200,{'content-type':'text/event-stream'})
  response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:reason}],usage})+'\n\ndata: [DONE]\n\n')
}
const backend = createServer(async (req,res) => {
  try {
    if (req.url==='/mcp') {
      const headers = req.headers
      if (req.method==='DELETE') {
        assert.ok(mcpSessions.delete(headers['mcp-session-id']))
        return res.writeHead(204).end()
      }
      let raw=''
      for await (const chunk of req) raw += chunk
      const rpc=JSON.parse(raw)
      if (rpc.method==='initialize') {
        const session=randomUUID()
        mcpSessions.add(session)
        assert.equal(rpc.params.protocolVersion,'2025-11-25')
        res.writeHead(200,{'content-type':'application/json','mcp-session-id':session})
        return res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{
          protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'},
        }}))
      }
      assert.ok(mcpSessions.has(headers['mcp-session-id']))
      assert.equal(headers['mcp-protocol-version'],'2025-11-25')
      if (rpc.method==='notifications/initialized') return res.writeHead(202).end()
      assert.equal(rpc.method,'tools/call')
      const { name, arguments:payload }=rpc.params
      mcpCalls.push(payload.eventName)
      let decision={allow:true}
      if (name==='rewrite') decision={rewrittenInput:{prompt:payload.input.prompt+' REWRITTEN'}}
      if (name==='followup' && payload.input.output==='MCP_CHECK_FIRST') decision={shouldContinue:true,reason:'MCP_GUARD_RETRY'}
      const result={jsonrpc:'2.0',id:rpc.id,result:{structuredContent:decision}}
      res.writeHead(200,{'content-type':'text/event-stream'})
      return res.end('data: '+JSON.stringify(result)+'\n\n')
    }
    assert.equal(req.url,'/v1/chat/completions')
    assert.equal(req.headers.authorization,'Bearer ' + key)
    let raw=''
    for await (const chunk of req) raw += chunk
    const input=JSON.parse(raw)
    const messages=input.messages
    const system=messages.find(item=>item.role==='system')?.content ?? ''
    const user=messages.find(item=>item.role==='user')?.content ?? ''
    const results=messages.filter(item=>item.role==='tool')
    requests.push({ system,user,results })
    if (user.startsWith('EVAL_CASE_')) {
      maxEvals=Math.max(maxEvals,++evals)
      await delay(80)
      evals--
      return completion(res,{content:system.includes('TESTING_V2') ? '合规证据' : '超长且缺乏结论的基线版本'})
    }
    if (system.includes('评分标准和样本')) {
      return completion(res,{content:JSON.stringify({pass:true,reason:'合成裁判通过'})})
    }
    if (user.includes('待用户审阅的 Markdown')) {
      return completion(res,{content:JSON.stringify({title:'Dream result',summary:'梦境合成建议'})})
    }
    if (user.includes('MCP_FLOW')) {
      assert.ok(user.includes('REWRITTEN'))
      if (messages.some(message=>message.role==='user'&&message.content.includes('MCP_GUARD_RETRY'))) {
        return completion(res,{content:'MCP_CHECK_REVISED'})
      }
      if (results.length) return completion(res,{content:'MCP_CHECK_FIRST'})
      return completion(res,{tool_calls:[{index:0,id:'mcp-search',type:'function',function:{
        name:'search_notes',arguments:JSON.stringify({query:'Updated note'})
      }}]},'tool_calls')
    }
    if (results.length) {
      return completion(res,{content:'工作任务合成结论。保留证据。'})
    }
    if (user.includes('HOOK_') || user.includes('SHADOW_FILE')) {
      return completion(res,{tool_calls:[{index:0,id:'file',type:'function',function:{
        name:'propose_file_write',arguments:JSON.stringify({path:existing,content:'approved file\n',rationale:'fixture'})
      }}]},'tool_calls')
    }
    if (user.includes('SHADOW_NOTE')) {
      return completion(res,{tool_calls:[{index:0,id:'note',type:'function',function:{
        name:'propose_note_update',arguments:JSON.stringify({noteId:targetNote,content:'# Updated note\n\nApproved note text.\n',rationale:'fixture'})
      }}]},'tool_calls')
    }
    if (user.includes('ISOLATION')) {
      return completion(res,{tool_calls:[{index:0,id:'search',type:'function',function:{
        name:'search_notes',arguments:JSON.stringify({query:'PRIVATE_MARKER'})
      }}]},'tool_calls')
    }
    return completion(res,{content:'工作任务合成结论。'})
  } catch (error) {
    errors.push(String(error))
    res.writeHead(500).end()
  }
})
async function port(server) {
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  return server.address().port
}
async function awaitHttp(url,child) {
  for (let i=0;i<180;i++) {
    assert.equal(child.exitCode,null,'child exited before ' + url)
    if (await fetch(url).then(response=>response.ok,()=>false)) return
    await delay(100)
  }
  throw Error('timeout ' + url)
}
const apiPort=await port(backend)
const debug=createServer()
const debugPort=await port(debug)
await new Promise(done=>debug.close(done))
const address='http://127.0.0.1:'+debugPort

try {
  if (!packaged) {
    vite=spawn(process.execPath,[join(source,'node_modules','vite','bin','vite.js'),'--strictPort'],{cwd:source,windowsHide:true,stdio:'ignore'})
    await awaitHttp('http://127.0.0.1:5173',vite)
  }
  app=spawn(resolve(process.argv[2] ?? join(source,'src-tauri','target','debug','plate-workbench.exe')),[],{
    cwd:sandbox,windowsHide:true,stdio:'inherit',env:{...process.env,PLATE_WORKSPACE_ROOT:workspace,
      PLATE_AGENT_SETTINGS_DIR:join(sandbox,'agent-settings'),WEBVIEW2_USER_DATA_FOLDER:join(sandbox,'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+debugPort}
  })
  await awaitHttp(address+'/json/version',app)
  browser=await chromium.connectOverCDP(address)
  page=browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(12_000)
  page.on('pageerror',error=>errors.push(String(error)))
  const nav=page.getByRole('navigation',{name:'主导航'})
  const button=name=>page.getByRole('button',{name,exact:true})
  const invoke=(command,args={})=>page.evaluate(([name,input])=>window.__TAURI_INTERNALS__.invoke(name,input),[command,args])
  await nav.waitFor()
  providerId=(await invoke('provider_upsert',{input:{
    name:'S11 fixture',kind:'openai_compatible',baseUrl:'http://127.0.0.1:'+apiPort+'/v1',
    defaultModel:'fixture',roles:['workbench_chat','brain_consolidator'],inputPricePer1m:0,outputPricePer1m:0,enabled:true,apiKey:key,
  }})).id
  await invoke('global_prompt_set',{prompt:'GLOBAL_FIXTURE'})
  const metadata=()=>invoke('brain_note_metadata')
  assert.equal((await metadata())[legacyId].spaceId,'learning')
  const navTo=(name)=>nav.getByRole('button',{name,exact:true}).click()
  await navTo('大脑视图')
  await page.getByRole('group',{name:'脑区',exact:true}).getByRole('button',{name:'工作',exact:true}).click()
  await page.getByRole('textbox',{name:'输入海马体闪念'}).fill('原始工作闪念')
  await page.getByRole('textbox',{name:'输入海马体闪念'}).press('Enter')
  await button('原始工作闪念').click()
  await page.getByRole('textbox',{name:'编辑候选记忆'}).fill('已编辑的工作闪念')
  await button('保存').click()
  await button('已编辑的工作闪念').hover()
  await button('升格为笔记').click()
  await page.getByRole('textbox',{name:'输入海马体闪念'}).waitFor()
  const made=(await invoke('notes_list')).find(note=>note.title==='已编辑的工作闪念')
  assert.ok(made)
  targetNote=made.id
  assert.equal((await metadata())[targetNote].spaceId,'work')
  const privateNote=await invoke('notes_create',{title:'PRIVATE_MARKER',projectId:'default',spaceId:'personal'})
  assert.equal((await metadata())[privateNote.id].spaceId,'personal')
  await invoke('set_brain_context',{enabled:true})
  checks.push('M1 legacy import, candidate edit/promotion, work and personal scopes')

  await navTo('工作台')
  const composer=page.locator('.composer-island')
  const bounds=await composer.boundingBox()
  await button('目标脑区').click()
  const popover=page.getByRole('region',{name:'目标脑区'})
  await popover.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
  assert.deepEqual(await composer.boundingBox(),bounds)
  assert.equal(await popover.getByRole('checkbox',{name:'个人'}).count(),0)
  const trigger=await button('目标脑区').boundingBox()
  const placed=await popover.boundingBox()
  assert.ok(Math.abs(trigger.y-placed.y-placed.height-8)<2)
  await page.keyboard.press('Escape')
  await popover.waitFor({state:'hidden'})

  const permissions={readableNoteIds:[targetNote,privateNote.id],readableLogSessionIds:[],allowAllNotesRead:true,
    writableDirs:[files],allowBrainNotePropose:true,allowShell:false,allowNetwork:true,maxSteps:4,maxBudgetUsd:0.2}
  const profile=await invoke('profile_upsert',{profile:{id:'',name:'办公验收预设',backendKind:'api_key',backendId:providerId,
    modelName:'fixture',reasoningEffort:'high',temperature:0.2,maxSteps:4,maxBudgetUsd:0.2,defaultSpaceId:'work',
    defaultPermissions:permissions}})
  await navTo('模型与权限')
  await navTo('工作台')
  const modelButton=button('模型与引擎')
  const modelPanel=page.getByRole('region',{name:'模型与引擎'})
  await modelButton.click()
  await modelPanel.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
  const modelAnchor=await modelButton.boundingBox()
  const modelBounds=await modelPanel.boundingBox()
  assert.ok(Math.abs(modelAnchor.y-modelBounds.y-modelBounds.height-8)<2)
  await modelPanel.getByRole('button',{name:/^办公验收预设/}).click()
  await page.keyboard.press('Escape')
  await button('任务权限').click()
  assert.equal(await page.getByLabel('步数上限').inputValue(),'4')
  assert.equal(await page.getByLabel('预算上限（美元）').inputValue(),'0.2')
  await page.keyboard.press('Escape')
  await button('预览四层提示词').click()
  await page.getByRole('dialog',{name:'预览四层提示词'}).getByText('权限边界',{exact:false}).waitFor()
  await page.keyboard.press('Escape')
  const runRequest=(prompt,extra={})=>({title:prompt,prompt,backendKind:'api_key',backendId:providerId,
    seedNoteId:targetNote,attachedLogSessionIds:[],permissions,spaceScope:{targetSpaceId:'work',readableSpaceIds:['personal']},...extra})
  const preview=await invoke('harness_preview_prompt',{request:runRequest('ISOLATION',{profileId:profile.id})})
  assert.deepEqual(preview.layers.map(layer=>layer.layerName),['global','workspace_rules','brain_and_skill','permissions'])
  for (const marker of ['GLOBAL_FIXTURE','AUTHORIZED_RULE_MARKER','已编辑的工作闪念']) assert.ok(preview.finalPrompt.includes(marker))
  assert.ok(!preview.finalPrompt.includes('PRIVATE_MARKER'))
  assert.ok(preview.finalPrompt.includes('"maxSteps": 4'))
  assert.ok(preview.finalPrompt.includes('"maxBudgetUsd": 0.2'))
  await assert.rejects(invoke('harness_preview_prompt',{request:runRequest('blocked',{seedNoteId:privateNote.id})}))

  async function run(prompt, extra={}) {
    const runId=await invoke('harness_start_run',{request:runRequest(prompt,extra)})
    for (let i=0;i<200;i++) {
      const current=(await invoke('harness_list_runs')).find(item=>item.id===runId)
      if (current && current.status!=='running') {
        const events=await invoke('harness_get_events',{runId})
        assert.ok(['review_ready','completed'].includes(current.status),JSON.stringify(events).slice(-4500))
        return {runId,events}
      }
      await delay(80)
    }
    throw Error('run timeout ' + prompt)
  }
  const isolation=await run('ISOLATION')
  assert.ok(isolation.events.some(event=>event.kind==='prompt_assembled'))
  assert.deepEqual(JSON.parse(requests.find(item=>item.user==='ISOLATION'&&item.results.length).results[0].content).notes,[])
  const noteBefore=(await invoke('notes_read',{id:targetNote})).content
  const noteRun=await run('SHADOW_NOTE')
  const [noteDiff]=await invoke('staging_list_diffs',{runId:noteRun.runId})
  assert.equal(noteDiff.executionMode,'shadow')
  assert.equal((await invoke('notes_read',{id:targetNote})).content,noteBefore)
  await invoke('staging_resolve_diff',{diffId:noteDiff.id,accept:true})
  assert.match((await invoke('notes_read',{id:targetNote})).content,/Approved note text/)
  const fileRun=await run('SHADOW_FILE')
  const [fileDiff]=await invoke('staging_list_diffs',{runId:fileRun.runId})
  assert.equal(await readFile(existing,'utf8'),'original file\n')
  await invoke('staging_resolve_diff',{diffId:fileDiff.id,accept:true})
  assert.equal(await readFile(existing,'utf8'),'approved file\n')
  const dreamId=await invoke('capture_episodic_event',{projectId:'default',rawText:'仅用于梦境审阅',spaceId:'work'})
  const dream=await invoke('dream_model_suggestion',{eventIds:[dreamId]})
  const dreamRun=await invoke('dream_stage',{eventIds:[dreamId],title:dream.title,synthesis:dream.summary})
  const [dreamDiff]=await invoke('staging_list_diffs',{runId:dreamRun})
  assert.equal(dreamDiff.targetKind,'brain_note')
  assert.equal((await metadata())[dreamDiff.targetRef],undefined)
  await invoke('staging_resolve_diff',{diffId:dreamDiff.id,accept:true})
  assert.equal((await metadata())[dreamDiff.targetRef].spaceId,'work')
  checks.push('M2 four-layer preview, profile limits, anchored menu, note/file/dream shadow approvals')

  const skillId=await invoke('save_workbench_skill',{input:{title:'办公评测',tags:['fixture'],system_prompt:'PRODUCTION_V1'},
    spaceId:'work',defaultProfileId:profile.id,allowNetwork:true,allowShell:false})
  const version=await invoke('prompt_version_create',{skillId,versionTag:'v2',systemPrompt:'TESTING_V2',changeNote:'fixture'})
  for (let i=0;i<3;i++) {
    await invoke('eval_case_upsert',{sample:{id:'',skillId,title:'样本 '+(i+1),inputPrompt:'EVAL_CASE_'+i,attachedContext:{fixture:i},
      assertions:[{kind:'max_chars',limit:5},{kind:'must_contain',text:'证据'},...(i===2?[{kind:'llm_rubric',criterion:'明确保留证据'}]:[])]}})
  }
  await navTo('技能')
  await page.getByRole('list',{name:'已保存技能'}).getByText('办公评测',{exact:true}).click()
  await button('回归评测').click()
  await page.getByLabel('评测版本').selectOption(version.id)
  await button('运行回归评测').click()
  await page.getByLabel('评测通过率').getByText('v2 · 100%（3/3）',{exact:true}).waitFor()
  await page.getByLabel('评测通过率').getByText('v1 · 0%（0/3）',{exact:true}).waitFor()
  assert.equal(maxEvals,3)
  await button('提示词版本').click()
  await page.getByText('v2 · 测试',{exact:true}).click()
  await button('设为生产版本').click()
  await page.getByText('v2 · 生产',{exact:true}).waitFor()
  const prod=await invoke('harness_preview_prompt',{request:runRequest('AFTER_PROMOTION',{skillId})})
  assert.ok(prod.finalPrompt.includes('TESTING_V2'))
  checks.push('M3 three samples, concurrency 3, rubric, production comparison, promotion and default use')

  const hook=await invoke('hooks_upsert',{hook:{id:'',name:'文件审阅守卫',eventName:'PreToolUse',matcher:'^propose_file_write$',
    handlerKind:'command',commandOrRef:'file:'+script,scriptSha256:'',trustedSha256:'',sourcePreview:'',timeoutSec:10,asyncRun:false,enabled:true}})
  // Reset the base file so skipped hooks can actually produce a new proposal.
  await writeFile(existing,'original file\n')
  const untrusted=await run('HOOK_UNTRUSTED')
  assert.ok(untrusted.events.some(event=>event.kind==='hook_needs_trust'))
  assert.ok(untrusted.events.every(event=>event.status!=='denied'))
  await navTo('模型与权限')
  await button('Hooks 与信任').click()
  await page.locator('summary').filter({hasText:'文件审阅守卫'}).click()
  await button('信任此哈希').click()
  await page.getByText('待信任',{exact:true}).waitFor({state:'hidden'})
  const trusted=await run('HOOK_TRUSTED')
  assert.ok(trusted.events.some(event=>event.kind==='hook_status'&&event.status==='denied'),JSON.stringify(trusted.events).slice(-7000))
  const feedback=requests.find(item=>item.user==='HOOK_TRUSTED'&&item.results.length)
  assert.match(feedback.results[0].content,/FIXTURE_FILE_REVIEW_REQUIRED/)
  assert.deepEqual(await invoke('staging_list_diffs',{runId:trusted.runId}),[])
  const [memory]=await invoke('harness_candidates',{runId:trusted.runId})
  assert.equal(memory.spaceId,'work')
  assert.equal(memory.sourceRunId,trusted.runId)
  assert.equal(memory.reviewStatus,'candidate')
  await invoke('episodic_update_candidate',{id:memory.id,newContent:'复核后的任务候选',spaceId:'work'})
  assert.equal((await invoke('harness_candidates',{runId:trusted.runId}))[0].rawText,'复核后的任务候选')
  await writeFile(script,denyScript.replace('FIXTURE_FILE_REVIEW_REQUIRED','TAMPERED'))
  const changed=await run('HOOK_TAMPERED')
  assert.ok(changed.events.some(event=>event.kind==='hook_needs_trust'&&event.scriptSha256!==hook.scriptSha256))
  assert.ok(requests.filter(item=>item.user==='HOOK_TAMPERED').every(item=>!JSON.stringify(item.results).includes('TAMPERED')))
  await invoke('hooks_toggle',{id:'builtin-session-memory',enabled:false})
  assert.deepEqual(await invoke('harness_candidates',{runId:(await run('DISABLED_MEMORY')).runId}),[])
  for (const [eventName,name] of [['UserPromptSubmit','rewrite'],['PostToolUse','observe'],['Stop','followup'],['SessionEnd','session']]) {
    const stored=await invoke('hooks_upsert',{hook:{id:'',name,eventName,matcher:'*',handlerKind:'mcp_tool',
      commandOrRef:'http://127.0.0.1:'+apiPort+'/mcp#'+name,scriptSha256:'',trustedSha256:'',sourcePreview:'',
      timeoutSec:10,asyncRun:false,enabled:true}})
    await invoke('hooks_trust',{id:stored.id,expectedSha256:stored.scriptSha256})
  }
  const mcp=await run('MCP_FLOW')
  assert.deepEqual(mcpCalls,['UserPromptSubmit','PostToolUse','Stop','Stop','SessionEnd'])
  assert.ok(mcp.events.some(event=>event.kind==='token_delta'&&event.delta==='MCP_CHECK_REVISED'))
  assert.equal(mcpSessions.size,0)
  checks.push('M4 hash trust, constrained hook runtime, tool denial feedback, all lifecycle events, MCP handshake and Stop retry, editable scoped memory')
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({checks,maxConcurrentEvals:maxEvals,rendererErrors:errors},null,2))
} finally {
  if (providerId && page) await page.evaluate(id=>window.__TAURI_INTERNALS__.invoke('provider_delete',{id}),providerId).catch(()=>{})
  await browser?.close().catch(()=>{})
  for (const child of [app,vite]) {
    if (child && child.exitCode===null) { child.kill(); await Promise.race([once(child,'exit'),delay(3000)]) }
  }
  backend.closeAllConnections()
  await new Promise(done=>backend.close(done))
  const cleanup=await realpath(sandbox)
  assert.equal(dirname(cleanup),temporary)
  assert.ok(basename(cleanup).startsWith('plate-s11-check-'))
  await rm(cleanup,{recursive:true,force:true,maxRetries:12,retryDelay:250})
}
