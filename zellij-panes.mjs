// Group-specific log panes in the current tab. Replacing a log pane never touches model processes.
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const slotFor=m=>['systemone','ocr'].includes(m?.slot)?m.slot:'llm';
const expand=p=>p.startsWith('~/')?join(process.env.HOME,p.slice(2)):p;
export function paneSlot(cfg,pane){
  if(pane.is_plugin)return null;
  const hay=[pane.terminal_command,pane.command,pane.pane_command].filter(Boolean).join('\n');
  const dir=expand(cfg.script_dir||'~/.cache/inference');
  // Match a complete path token, not e.g. llama.log.backup or a similar prefix.
  const contains=path=>hay.split(/[\s"']+/).includes(path);
  for(const [slot,file] of Object.entries({llm:'llama.log',systemone:'systemone.log',ocr:'ocr.log'}))if(contains(join(dir,file)))return slot;
  for(const [name,m] of Object.entries(cfg.models||{}))if(contains(join(dir,`${name}.view.sh`)))return slotFor(m);
  return null;
}
const paneId=p=>p.pane_id??`terminal_${p.id}`;
export function planView(cfg,slot,profile,script,tabs,panes){
  const tab=tabs.find(t=>t.active);
  if(!tab)throw new Error('Cannot determine the active Zellij tab; no panes changed.');
  const owned=panes.filter(p=>paneSlot(cfg,p)===slot);
  const keep=owned.find(p=>p.tab_id===tab.tab_id);
  const args=['action','new-pane','--name',profile];
  if(keep)args.push('--in-place','--close-replaced-pane','--pane-id',paneId(keep));
  else {
    args.push('--tab-id',String(tab.tab_id));
    if(cfg.zellij?.direction)args.push('--direction',cfg.zellij.direction);
  }
  if(cfg.zellij?.focus!==true)args.push('--no-focus');
  args.push('--',script);
  return {args,tabName:tab.name,close:owned.filter(p=>p!==keep).map(paneId)};
}
export function launchGroupedView(cfg,slot,profile,script,{run=spawnSync,dryRun=false}={}){
  const session=cfg.zellij?.session??process.env.ZELLIJ_SESSION_NAME;
  const prefix=session?['--session',String(session)]:[];
  const action=args=>{
    const r=run('zellij',[...prefix,...args],{encoding:'utf8'});
    if(r.error||r.status!==0)throw new Error(`Zellij ${args[1]} failed: ${r.error?.message||r.stderr||r.stdout}`);
    return r.stdout?.trim()||'';
  };
  const list=(kind)=>{const r=JSON.parse(action(['action',`list-${kind}`,'-a','-j']));return Array.isArray(r)?r:r[kind]||[];};
  const plan=planView(cfg,slot,profile,script,list('tabs'),list('panes'));
  console.log(`${dryRun?'[dry-run] ':''}Zellij ${slot} log pane → current tab '${plan.tabName}': ${JSON.stringify([...prefix,...plan.args])}`);
  if(!dryRun){
    action(plan.args); // Create/replace successfully before removing duplicates.
    for(const id of plan.close)action(['action','close-pane','-p',id]);
  }
  return plan;
}
