import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, useMotionValue } from 'framer-motion'
import type { SessionAdapter, SessionStatus } from '../../shared/sessions'

const reduceQuery = '(prefers-reduced-motion: reduce)'
export function useQuietBots() {
  const [quiet, setQuiet] = useState(() => matchMedia(reduceQuery).matches || document.hidden)
  useEffect(() => {
    const query = matchMedia(reduceQuery)
    const sync = () => setQuiet(query.matches || document.hidden)
    query.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    return () => { query.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync) }
  }, [])
  return quiet
}

const gazeLimit=30, gazeDelay=80, gazeLerp=.15
const ease = 'easeInOut' as const
export type BotPresence = Map<string, { node: HTMLDivElement; status: SessionStatus; animated: boolean }>
export function AgentBot({ adapter, status, quiet, presence, sessionKey }: {
  adapter: SessionAdapter; status: SessionStatus; quiet: boolean; presence: BotPresence; sessionKey: string
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<boolean>()
  const animated = visible === true && !quiet
  const previous=useRef(status)
  const movedWhileVisible=useRef<SessionStatus | undefined>(undefined)
  useLayoutEffect(() => {
    const node=anchor.current!
    const old=presence.get(sessionKey)
    if(old?.animated && old.status!==status) movedWhileVisible.current=status
    // Keep the outgoing snapshot through a synchronous group move. A card
    // absent at the end of this commit must not replay an offscreen change.
    return () => queueMicrotask(()=>{if(presence.get(sessionKey)?.node===node)presence.delete(sessionKey)})
  }, [presence, sessionKey])
  useLayoutEffect(()=>{
    presence.set(sessionKey,{node:anchor.current!,status,animated})
  },[presence,sessionKey,status,animated])
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting&&entry.intersectionRatio>=.75),{threshold:.75})
    observer.observe(anchor.current!)
    return ()=>observer.disconnect()
  },[])
  const x = useMotionValue(0), y = useMotionValue(0)
  useEffect(() => {
    if (!animated) { x.set(0); y.set(0); return }
    const surface = anchor.current?.closest('.session-card')
    if (!surface) return
    let frame=0, timing=0, targetX=0, targetY=0, pendingX=0, pendingY=0
    const advance=()=>{
      const dx=targetX-x.get(),dy=targetY-y.get()
      if(Math.hypot(dx,dy)<.03){x.set(targetX);y.set(targetY);frame=0;return}
      x.set(x.get()+dx*gazeLerp);y.set(y.get()+dy*gazeLerp)
      frame=requestAnimationFrame(advance)
    }
    const reset = () => {
      clearTimeout(timing);cancelAnimationFrame(frame);frame=timing=0
      targetX=targetY=pendingX=pendingY=0;x.set(0);y.set(0)
    }
    const move = (e: Event) => {
      const event = e as PointerEvent
      if (event.pointerType === 'touch' || !anchor.current) return
      const r = anchor.current.getBoundingClientRect()
      const dx = event.clientX - (r.left + r.width / 2)
      const dy = event.clientY - (r.top + r.height / 2)
      const clamp=(offset:number)=>Math.max(-gazeLimit,Math.min(gazeLimit,Math.atan2(offset,Math.max(1,r.width/2))*180/Math.PI))
      pendingX=4.5*clamp(dx)/gazeLimit;pendingY=4.5*clamp(dy)/gazeLimit
      if(!timing)timing=window.setTimeout(()=>{
        timing=0;targetX=pendingX;targetY=pendingY;if(!frame)frame=requestAnimationFrame(advance)
      },gazeDelay)
    }
    surface.addEventListener('pointermove', move)
    surface.addEventListener('pointerleave', reset)
    surface.addEventListener('pointercancel',reset)
    window.addEventListener('blur', reset)
    return () => {
      surface.removeEventListener('pointermove', move); surface.removeEventListener('pointerleave', reset)
      surface.removeEventListener('pointercancel',reset)
      window.removeEventListener('blur', reset);reset()
    }
  }, [animated, x, y])
  const [entry,setEntry]=useState<SessionStatus>()
  useEffect(() => {
    const changed=previous.current!==status
    previous.current=status
    if(quiet || visible!==undefined && !animated || movedWhileVisible.current!==status) movedWhileVisible.current=undefined
    const entered=changed || movedWhileVisible.current===status
    const ms=({PENDING:400,REVIEW:800,ERROR:300,DONE:300} as Partial<Record<SessionStatus,number>>)[status]
    if (!entered || !animated || !ms) {setEntry(undefined);return}
    movedWhileVisible.current=undefined
    setEntry(status)
    const timer=window.setTimeout(()=>setEntry(undefined),ms)
    return ()=>clearTimeout(timer)
  }, [status, animated, quiet, visible])
  const review = status === 'REVIEW'
  const deepseek = adapter === 'deepseek'
  const oneShot=animated && entry===status
  const bob = oneShot && status === 'PENDING'
  const shake = oneShot && status === 'ERROR'
  const blink = oneShot && status === 'DONE'
  const breath = animated && status === 'DOING'
  return <div className="agent-bot-anchor" ref={anchor} aria-hidden="true" data-animated={animated}>
    <motion.svg viewBox="0 0 48 48" className="agent-bot" data-brand={adapter} initial={false}
      animate={bob ? { y: [0, -4, 0], scale:1, x: 0 }
        : breath ? { scale: [1, 1.08, 1], x: 0, y: 0 }
        : shake ? { x: [0, 4, -4, 0], y: 0, scale: 1 } : { x: 0, y: 0, scale: 1 }}
      transition={bob ? { duration:.4, ease }
        : breath ? { duration: 1.2, repeat: Infinity, ease }
        : { duration: shake ? .3 : 0, ease }}>
      {deepseek
        ? <path className="bot-body" d="M7 26c0-9 7-16 17-16 7 0 10 2 13 5l6-4c0 5-2 9-6 11 3 2 4 5 3 9-1 6-8 9-16 9-10 0-17-5-17-14Z"/>
        : <path className="bot-body" d="M10 15c2-5 7-7 14-7s12 2 14 7l2 15c0 7-6 10-16 10S8 37 8 30Z"/>}
      <path className="bot-mark" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6"
        d={deepseek ? 'M13 17q4-4 9-3' : adapter === 'zcode' ? 'M21 14h6l-6 5h6' : 'M19 14l3 2-3 2m7 0h4'}/>
      <motion.g className="bot-gaze" style={{ x, y }}>
        {review ? <motion.g className="bot-smile" fill="none" strokeLinecap="round" strokeWidth="2.2"
          initial={false} animate={oneShot ? {opacity:[.5,1],scaleY:[.5,1]} : { opacity: 1, scaleY: 1 }}
          transition={{ duration: oneShot ? .8 : 0 }} style={{ transformOrigin: 'center' }}>
          <path d="M16 25q3-5 6 0m4 0q3-5 6 0m-11 5q3 3 6 0"/>
        </motion.g> : <motion.g className="bot-eyes" initial={false} style={{transformOrigin:'center'}}
          animate={{scaleY:blink?[1,.1,1]:1}} transition={{duration:blink?.3:0}}>
          <circle cx="18" cy="25.5" r="3"/><circle cx="30" cy="25.5" r="3"/>
        </motion.g>}
      </motion.g>
      {status === 'ERROR' && <path className="bot-mark" d="M22 33h4" strokeWidth="2" strokeLinecap="round"/>}
    </motion.svg>
  </div>
}
