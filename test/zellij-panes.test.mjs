import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planView,paneSlot,launchGroupedView} from '../zellij-panes.mjs';
import {processSlot} from '../process-slots.mjs';
const cfg={script_dir:'/logs',models:{text:{},h2o:{slot:'systemone'},ocr:{slot:'ocr'}},zellij:{}};
const tabs=[{tab_id:0,name:'Main',active:true},{tab_id:8,name:'Other',active:false}];
const panes=[{id:1,tab_id:0,terminal_command:'/logs/text.view.sh'},{id:2,tab_id:0,pane_command:'tail -F /logs/systemone.log'},{id:3,tab_id:0,pane_command:'tail -F /logs/ocr.log'},{id:4,tab_id:0,pane_command:'mari'}];
test('relaunch replaces only its own group pane and preserves focus',()=>{
 for(const [slot,id] of [['llm',1],['systemone',2],['ocr',3]]){
  const p=planView(cfg,slot,'profile','/view',tabs,panes);
  assert.ok(p.args.includes('--in-place'));assert.ok(p.args.includes(`terminal_${id}`));assert.ok(p.args.includes('--no-focus'));assert.deepEqual(p.close,[]);
 }
});
test('new group opens a pane in current tab, never a new tab',()=>{
 const p=planView(cfg,'ocr','ocr','/view',tabs,panes.filter(p=>p.id!==3));
 assert.deepEqual(p.args.slice(0,2),['action','new-pane']);assert.ok(p.args.includes('--tab-id'));assert.ok(p.args.includes('0'));assert.deepEqual(p.close,[]);
});
test('switching tabs relocates only the launched group',()=>{
 const switched=tabs.map(t=>({...t,active:t.tab_id===8}));
 const p=planView(cfg,'ocr','ocr','/view',switched,panes);
 assert.ok(p.args.includes('8'));assert.deepEqual(p.close,['terminal_3']);assert.equal(p.tabName,'Other');
});
test('paths must match exactly and plugins are never closed',()=>{
 assert.equal(paneSlot(cfg,{pane_command:'tail /logs/ocr.log.backup'}),null);
 assert.equal(paneSlot(cfg,{...panes[2],is_plugin:true}),null);
});
test('missing active-tab metadata fails without creating a tab',()=>{
 assert.throws(()=>planView(cfg,'ocr','ocr','/view',[],panes),/active Zellij tab/);
});
test('failed creation never removes previous panes',()=>{
 const calls=[];const run=(cmd,args)=>{calls.push(args);if(args[1]==='list-tabs')return {status:0,stdout:JSON.stringify(tabs)};if(args[1]==='list-panes')return {status:0,stdout:JSON.stringify([{...panes[2],tab_id:8}])};return {status:1,stderr:'failure'};};
 assert.throws(()=>launchGroupedView(cfg,'ocr','ocr','/view',{run}),/failed/);assert.ok(!calls.some(a=>a.includes('close-pane')));
});
test('text and Jev llama-server processes remain separate; launch commands are not servers',()=>{
 assert.equal(processSlot('llama-server',['llama-server','--port','1237']),'systemone');
 assert.equal(processSlot('llama-server',['llama-server','--port','1234']),'llm');
 assert.equal(processSlot('paddle-ocr',['python','ocr-server.py']),'ocr');
 assert.equal(processSlot('bun',['bun','inference.mjs','h2o-lightning-4b']),null);
});
