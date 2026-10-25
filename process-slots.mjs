// Classify actual server processes, not launch commands that mention a model.
export function processSlot(comm,argv){
  if(comm==='paddle-ocr')return 'ocr';
  if(['h2o-serve','vllm','laya-serve'].includes(comm))return 'systemone';
  if(argv.some(a=>a==='h2o_lightning_shim'||a.split('/').pop()==='h2o_lightning_shim.py'))return 'systemone';
  if(!['llama-server','ninfer-serve','strata-serve'].includes(comm))return null;
  const port=argv.find(a=>a.startsWith('--port='))?.split('=')[1]??argv[argv.indexOf('--port')+1];
  if(port==='1246')return 'vision';
  if(port==='1237'||argv.some(a=>a.includes('h2o-lightning-4b')))return 'systemone';
  return 'llm';
}
