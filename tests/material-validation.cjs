const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createApp } = require('../server/index.cjs');

const fixture = {
  id: 'local-validation', title: 'Validation', createdAt: 1, duration: 3, wpm: 60,
  sentences: [{ id: 1, en: 'First line.', zh: '', t0: 0, t1: 1 }, { id: 2, en: 'Second line.', zh: '', t0: 1.5, t1: 2.5 }],
  validation: { status: 'passed' }, // An upload cannot forge the acoustic verdict.
};
const report = () => ({ schema: 1, duration: 3, rows: fixture.sentences.map((s, i) => ({
  id: s.id, en: s.en, original: { t0: s.t0, t1: s.t1 }, t0: s.t0 + .1, t1: s.t1 + .1,
  status: i === 1 ? 'review' : 'verified', reasons: i === 1 ? ['句尾定位不确定'] : [], coverage: i === 1 ? .5 : 1, changed: true,
})) });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('上传自动校验，低置信度阻止通过，试听确认后原子发布并保留文件和进度', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lh-validation-'));
  const options = { dbPath: join(directory, 'test.sqlite3'), mediaDir: join(directory, 'media') };
  let task = defer(), signal, server, base;
  const runner = args => { signal = args.signal; args.onProgress({ progress: 40, message: '正在比对测试音频' }); return task.promise; };
  async function start() { server=createApp({ ...options, validationRunner: runner }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base='http://localhost:'+server.address().port+'/api/'; }
  async function request(path, options={}, status=200) { const res=await fetch(base+path,options); assert.equal(res.status,status,path); return res.json(); }
  const post = body => ({ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });
  async function until(status, predicate = () => true) { for(let i=0;i<150;i++){ const c=await request('materials/'+fixture.id+'/validation');if(c.status===status && predicate(c))return c;await sleep(10); }throw new Error('Timed out '+status); }
  async function stop() {server.close();await once(server,'close');}
  async function upload() {
    const form=new FormData();form.set('metadata',JSON.stringify(fixture));form.set('audio',new Blob(['original audio']),'input.mp3');form.set('subtitle',new Blob(['original subtitles']),'input.vtt');
    return request('materials',{method:'POST',body:form},201);
  }
  try {
    await start();
    await request('state/lh_dictation_'+fixture.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:'{"all":{"1":{"input":"saved answer","score":100}}}',revision:1})});
    const originalState=await request('state');
    const uploaded=await upload();assert.ok(['queued','running'].includes(uploaded.validation.status));
    assert.equal((await until('running', check => check.progress === 40)).progress,40);
    assert.notEqual((await request('materials/'+fixture.id)).validation.status,'passed');
    task.resolve(report());const review=await until('review');assert.equal(review.remaining,1);
    assert.equal((await request('materials/'+fixture.id)).sentences[0].t0,0,'no premature publication');
    const preview=await fetch(base+'materials/'+fixture.id+'/validation/audio',{headers:{Range:'bytes=0-3'}});assert.equal(preview.status,206);assert.equal(await preview.text(),'orig');
    const body={revision:review.revision,sentenceId:2,t0:1.6,t1:2.6,confirmed:true};
    await request('materials/'+fixture.id+'/validation/review',post({...body,revision:'stale'}),409);
    await request('materials/'+fixture.id+'/validation/review',post({...body,confirmed:false}),400);
    await request('materials/'+fixture.id+'/validation/review',post({...body,t1:30}),400);
    const passed=await request('materials/'+fixture.id+'/validation/review',post(body));assert.equal(passed.status,'passed');
    const material=await request('materials/'+fixture.id);assert.deepEqual(material.sentences.map(s=>s.id),[1,2]);assert.equal(material.sentences[0].t0,.1);assert.equal(material.sentences[1].t1,2.6);
    assert.deepEqual((await request('state')).entries,originalState.entries);
    const { readdir }=require('node:fs/promises');const folder=(await readdir(options.mediaDir))[0];
    assert.equal(await readFile(join(options.mediaDir,folder,'audio.mp3'),'utf8'),'original audio');
    assert.equal(await readFile(join(options.mediaDir,folder,'subtitles.vtt'),'utf8'),'original subtitles');
    assert.match(await (await fetch(base+'materials/'+fixture.id+'/subtitle')).text(),/00:00:00.100 --> 00:00:01.100/);
    await stop();await start();assert.equal((await request('materials/'+fixture.id+'/validation')).status,'passed');
    // Failed workers must remain blocked; retry persists and recovers after a restart.
    task=defer();await request('materials/'+fixture.id+'/validation',{method:'POST'},202);await until('running', check => check.progress === 40);
    task.reject(new Error('识别失败'));assert.match((await until('failed')).message,/识别失败/);
    task=defer();await request('materials/'+fixture.id+'/validation',{method:'POST'},202);await until('running', check => check.progress === 40);await stop();assert.equal(signal.aborted,true);
    task=defer();await start();await until('running', check => check.progress === 40);task.resolve({...report(),rows:report().rows.map(r=>({...r,status:'verified'}))});await until('passed');
    task=defer();await request('materials/'+fixture.id+'/validation',{method:'POST'},202);await until('running', check => check.progress === 40);
    await request('materials/'+fixture.id,{method:'DELETE'});assert.equal(signal.aborted,true);task.resolve(report());await sleep(30);
    await request('materials/'+fixture.id+'/validation',{},404);assert.equal((await request('materials')).materials.length,0);
  } finally { if(server?.listening)await stop();await rm(directory,{recursive:true,force:true}); }
});

test('自动修正直接发布，保留源句和进度，只把可靠句子放入听写', async () => {
  const directory=await mkdtemp(join(tmpdir(),'lh-auto-repair-'));
  const meta={...fixture,id:'local-auto-repair',validation:undefined,sentences:[...fixture.sentences,{id:3,en:'Third line.',zh:'',t0:2.6,t1:2.9}]};
  let fail=false;
  const server=createApp({dbPath:join(directory,'state.sqlite3'),mediaDir:join(directory,'media'),validationRunner:async()=>({schema:2,duration:3,rows:meta.sentences.map((s,i)=>({
    id:s.id,en:s.en,original:{t0:s.t0,t1:s.t1},t0:s.t0+.02,t1:s.t1+.02,
    status:fail || i===1?'excluded':'repaired',changed:true,reasons:i===1?['无法可靠识别']:[],
  }))})});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://localhost:'+server.address().port+'/api/';
  try {
    const form=new FormData();form.set('metadata',JSON.stringify(meta));form.set('audio',new Blob(['original audio']),'a.mp3');form.set('subtitle',new Blob(['source subtitle']),'s.vtt');
    assert.equal((await fetch(base+'materials',{method:'POST',body:form})).status,201);
    let check;
    for(let i=0;i<100;i++){check=await(await fetch(base+'materials/'+meta.id+'/validation')).json();if(check.status==='passed')break;await sleep(10);}
    assert.equal(check.status,'passed');assert.equal(check.remaining,0);assert.equal(check.ready,2);assert.equal(check.excluded,1);
    const actual=await(await fetch(base+'materials/'+meta.id)).json();assert.deepEqual(actual.sentences.map(s=>s.en),meta.sentences.map(s=>s.en));
    assert.equal(actual.sentences[0].t0,.02);assert.equal(actual.sentences[1].t0,meta.sentences[1].t0);assert.deepEqual(actual.dictationExcluded,[2]);
    const subtitles=await(await fetch(base+'materials/'+meta.id+'/subtitle')).text();assert.match(subtitles,/First line/);assert.match(subtitles,/Third line/);assert.doesNotMatch(subtitles,/Second line/);
    fail=true;await fetch(base+'materials/'+meta.id+'/validation',{method:'POST'});
    for(let i=0;i<100;i++){check=await(await fetch(base+'materials/'+meta.id+'/validation')).json();if(check.status==='failed')break;await sleep(10);}
    assert.equal(check.status,'failed');assert.match(check.message,/匹配程度过低/);
    assert.equal((await(await fetch(base+'materials/'+meta.id)).json()).sentences[0].t0,.02,'failed repair cannot overwrite active timing');
  }finally{server.close();await once(server,'close');await rm(directory,{recursive:true,force:true});}
});
