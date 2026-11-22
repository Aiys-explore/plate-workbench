import { useCallback, useEffect, useState } from 'react'
import { Check, FlaskConical, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import type { BrainSkill } from '../../../shared/brain'
import type { EvalAssertion, EvalCase, EvalRun, PromptStatus, PromptVersion } from '../../../shared/harness'
import { IconAction } from '../icon-action'

const api = () => window.workbench.harness
const statuses: Record<PromptStatus,string> = { testing: '测试', production: '生产', retired: '退役' }
const ruleLabels: Record<EvalAssertion['kind'],string> = {
  max_chars: '字数上限', must_contain: '必须包含', must_not_contain: '不得包含',
  must_have_citation_link: '包含引用链接', llm_rubric: 'AI 裁判',
}

export function SkillGovernance({ skill, tab }: { skill: BrainSkill; tab: 'versions' | 'evals' }) {
  const [versions, setVersions] = useState<PromptVersion[]>([])
  const [samples, setSamples] = useState<EvalCase[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const production = versions.find(version => version.status === 'production')
  const refresh = useCallback(async () => {
    const [versionList, caseList, history] = await Promise.all([
      api().promptVersions(skill.id), api().evalCases(skill.id), api().evalRuns(skill.id),
    ])
    setVersions(versionList)
    setSamples(caseList)
    setRuns(history)
  }, [skill.id])
  useEffect(() => { void refresh().catch(cause => setError(String(cause))) }, [refresh])
  async function act(action: () => Promise<unknown>) {
    setError('')
    setBusy(true)
    try { await action(); await refresh() }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }

  return <div className="s11-governance" aria-busy={busy}>
    {error && <p role="alert">{error}</p>}
    {tab === 'versions' ? <>
      <div className="s11-trace">
        {versions.map(version => <details key={version.id}>
          <summary>{version.versionTag} · {statuses[version.status]}</summary>
          {version.changeNote && <p>{version.changeNote}</p>}
          <pre>{version.systemPrompt}</pre>
          <div className="s10-actions">
            {version.status !== 'production' && <IconAction icon={version.status === 'retired' ? RotateCcw : Check}
              label={version.status === 'retired' ? '回滚到此版本' : '设为生产版本'} disabled={busy}
              onClick={() => void act(() => api().setVersionStatus(version.id, 'production'))}/>}
            {version.status !== 'production' && <IconAction icon={version.status === 'testing' ? Trash2 : FlaskConical}
              label={version.status === 'testing' ? '退役测试版本' : '恢复为测试'} disabled={busy}
              onClick={() => void act(() => api().setVersionStatus(version.id, version.status === 'testing' ? 'retired' : 'testing'))}/>}
          </div>
        </details>)}
      </div>
      <VersionEditor key={production?.id} skillId={skill.id} system={production?.systemPrompt ?? skill.systemPrompt}
        busy={busy} save={input => act(async () => {
          const version = await api().createVersion(input)
          setSelected(version.id)
        })}/>
    </> : <>
      <div className="s11-trace">
        {samples.map(sample => <details key={sample.id}>
          <summary>{sample.title} · {sample.assertions.length} 项断言</summary>
          <CaseEditor initial={sample} busy={busy} save={current => act(() => api().saveEvalCase(current))}
            remove={() => void act(() => api().deleteEvalCase(skill.id, sample.id))}/>
        </details>)}
      </div>
      <details open={samples.length === 0}><summary>添加评测样本</summary>
        <CaseEditor key={samples.length} initial={blankCase(skill.id)} busy={busy} save={current => act(() => api().saveEvalCase(current))}/>
      </details>
      <div className="s10-run-form">
        <label>评测版本<select value={selected || production?.id || ''} onChange={event => setSelected(event.target.value)}>
          {!production && <option value="">选择版本</option>}
          {versions.map(version => <option key={version.id} value={version.id}>{version.versionTag} · {statuses[version.status]}</option>)}
        </select></label>
        <p className="s10-quiet-empty">向技能设定的 API Profile 或工作台模型发送样本，使用同一批样本比较生产版本。</p>
        <button type="button" disabled={busy || !samples.length || !(selected || production?.id)}
          onClick={() => void act(() => api().runEval(skill.id, selected || production!.id))}>{busy ? '正在处理…' : '运行回归评测'}</button>
      </div>
      {runs.length > 0 && <div className="s11-trace" aria-label="评测通过率">
        {[selected || production?.id, production?.id].filter((id,i,all) => id && all.indexOf(id) === i).map(id => {
          const run = runs.find(item => item.promptVersionId === id)
          return <p key={id}>{versions.find(version => version.id === id)?.versionTag ?? id} · {run
            ? `${Math.round(run.passedCases / run.totalCases * 100)}%（${run.passedCases}/${run.totalCases}）` : '暂无结果'}</p>
        })}
        {runs.map(run => <details key={run.id}>
          <summary>{versions.find(version => version.id === run.promptVersionId)?.versionTag}
            {' · '}{run.passedCases}/{run.totalCases} · {new Date(run.createdAt).toLocaleString('zh-CN')}</summary>
          {run.results.map(result => <article key={result.caseId}>
            <strong>{result.title} · {result.passed ? '通过' : '未通过'}</strong>
            {result.error && <p>{result.error}</p>}
            <pre>{result.output}</pre>
            <ul>{result.checks.map((check, i) => <li key={i}>{ruleLabels[check.assertion.kind]} · {check.passed ? '通过' : '未通过'}
              {check.reason && ' · ' + check.reason}</li>)}</ul>
          </article>)}
        </details>)}
      </div>}
    </>}
  </div>
}

function VersionEditor({ skillId, system, save, busy }: {
  skillId: string; system: string; busy: boolean
  save: (request: { skillId: string; versionTag: string; systemPrompt: string; changeNote: string }) => Promise<void>
}) {
  const [tag, setTag] = useState('')
  const [prompt, setPrompt] = useState(system)
  const [note, setNote] = useState('')
  return <form className="s10-run-form" onSubmit={event => {
    event.preventDefault()
    void save({ skillId, versionTag:tag, systemPrompt:prompt, changeNote:note })
  }}>
    <label>测试版本标签<input value={tag} required maxLength={100} onChange={event => setTag(event.target.value)}/></label>
    <label>系统提示词<textarea rows={7} value={prompt} required onChange={event => setPrompt(event.target.value)}/></label>
    <label>变更说明<input value={note} onChange={event => setNote(event.target.value)}/></label>
    <button type="submit" disabled={busy || !tag.trim() || !prompt.trim()}>保存测试版本</button>
  </form>
}

const blankCase = (skillId: string): EvalCase => ({
  id: '', skillId, title: '', inputPrompt: '', attachedContext: {}, assertions: [{ kind:'max_chars',limit:200 }],
})
function newRule(kind: EvalAssertion['kind']): EvalAssertion {
  switch (kind) {
    case 'max_chars': return { kind, limit:200 }
    case 'must_contain':
    case 'must_not_contain': return { kind, text:'' }
    case 'llm_rubric': return { kind, criterion:'' }
    case 'must_have_citation_link': return { kind }
  }
}

function CaseEditor({ initial, busy, save, remove }: {
  initial: EvalCase; busy: boolean; save: (sample: EvalCase) => Promise<void>; remove?: () => void
}) {
  const [sample, setSample] = useState(initial)
  const [context, setContext] = useState(initial.attachedContext && Object.keys(Object(initial.attachedContext)).length
    ? JSON.stringify(initial.attachedContext) : '')
  const [error, setError] = useState('')
  function setRule(index: number, rule: EvalAssertion) {
    setSample(current => ({ ...current, assertions: current.assertions.map((item,i) => i === index ? rule : item) }))
  }
  return <form className="s10-run-form" onSubmit={event => {
    event.preventDefault()
    try { setError(''); void save({ ...sample, attachedContext: context.trim() ? JSON.parse(context) : {} }) }
    catch { setError('样本上下文需要有效的 JSON。') }
  }}>
    <label>样本名称<input value={sample.title} required onChange={event => setSample({ ...sample, title:event.target.value })}/></label>
    <label>任务输入<textarea rows={3} value={sample.inputPrompt} required onChange={event => setSample({ ...sample, inputPrompt:event.target.value })}/></label>
    <label>样本上下文（JSON，可留空）<textarea rows={2} value={context} onChange={event => setContext(event.target.value)}/></label>
    {sample.assertions.map((rule, i) => <div className="s11-assertion" key={i}>
      <label>断言<select value={rule.kind} onChange={event => setRule(i, newRule(event.target.value as EvalAssertion['kind']))}>
        {Object.entries(ruleLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      {rule.kind === 'max_chars' && <label>最大字符数<input type="number" min="1" max="24000" value={rule.limit} onChange={event => setRule(i,{ ...rule, limit:Number(event.target.value) })}/></label>}
      {'text' in rule && <label>关键词<input value={rule.text} required onChange={event => setRule(i,{ ...rule,text:event.target.value })}/></label>}
      {rule.kind === 'llm_rubric' && <label>评分标准<input required value={rule.criterion} onChange={event => setRule(i,{ ...rule,criterion:event.target.value })}/></label>}
      <IconAction icon={Trash2} label="移除断言" disabled={busy || sample.assertions.length < 2}
        onClick={() => setSample({ ...sample, assertions:sample.assertions.filter((_,index) => index !== i) })}/>
    </div>)}
    {error && <p role="alert">{error}</p>}
    <div className="s10-actions">
      <IconAction icon={Plus} label="添加断言" disabled={busy || sample.assertions.length >= 12}
        onClick={() => setSample({ ...sample, assertions:[...sample.assertions,newRule('must_contain')] })}/>
      <IconAction icon={Save} label="保存样本" type="submit" disabled={busy}/>
      {remove && <IconAction icon={Trash2} label="删除样本" danger disabled={busy} onClick={remove}/>}
    </div>
  </form>
}
