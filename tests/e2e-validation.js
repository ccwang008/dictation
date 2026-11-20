const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const BASE=process.env.BASE || 'http://localhost:8080/index.html';
const CHROME=process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out=[];
function wav(){ const size=3*16000*2;const b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(size+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);return b; }
(async()=>{
 const browser=await chromium.launch({executablePath:CHROME,headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(BASE);await page.click('nav >> text=开始练习');await page.click('aside >> text=我的素材');
 async function upload(title){
  await page.getByRole('button',{name:'导入音频 + 字幕'}).click();
  await page.setInputFiles('input[accept^="audio"]',{name:'validation.wav',mimeType:'audio/wav',buffer:wav()});
  await page.setInputFiles('input[accept^=".lrc"]',{name:'validation.srt',mimeType:'text/plain',buffer:Buffer.from('1\n00:00:00,100 --> 00:00:00,600\nHello there.\n\n2\n00:00:01,000 --> 00:00:01,500\nGood morning.\n\n3\n00:00:02,000 --> 00:00:02,500\nSee you later.\n')});
  await page.getByRole('textbox',{name:'标题',exact:true}).fill(title);
  await page.getByRole('button',{name:'导入',exact:true}).click();
 }
 const dialog=page.getByRole('dialog',{name:'声音与字幕自动修正'});
 await upload('自动修正测试');await dialog.getByRole('button',{name:'开始听写',exact:true}).waitFor();
 assert.equal(await dialog.getByRole('button',{name:'已听完，确认同步'}).count(),0);out.push('PASS 导入后自动修正并直接完成，不要求逐句确认');
 await dialog.getByRole('button',{name:'开始听写',exact:true}).click();
 await page.getByRole('textbox',{name:'听写答案'}).waitFor();
 let state=await page.evaluate(()=>{const L=window.__LH__.L;return {id:L.current.id,start:L.dictSentence.t0,queue:L.dictation.queue,focus:document.activeElement.id};});
 assert.equal(state.start,.18);assert.deepEqual(state.queue,[1,2,3]);assert.equal(state.focus,'dictation-input');out.push('PASS 听写直接使用已自动修正的时间轴，保留原题号并聚焦');
 await upload('修正部分无法识别');await dialog.getByRole('button',{name:'开始听写',exact:true}).waitFor();
 const summary=dialog.locator('summary');assert.equal(await summary.count(),1);assert.equal(await dialog.getByRole('spinbutton').first().isVisible(),false);out.push('PASS 少数无法修复句子仅单独提示，不阻塞已修好的素材');
 await page.setViewportSize({width:390,height:780});assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
 await page.screenshot({path:'/tmp/listeninghub-auto-repair-mobile.png'});
 await dialog.getByRole('button',{name:'开始听写',exact:true}).click();await page.getByRole('textbox',{name:'听写答案'}).waitFor();
 state=await page.evaluate(()=>{const L=window.__LH__.L;return {id:L.current.id,queue:L.dictation.queue,excluded:L.current.dictationExcluded};});assert.deepEqual(state.queue,[1,3]);assert.deepEqual(state.excluded,[2]);
 await page.evaluate(()=>{const L=window.__LH__.L;L.toggleHard(L.sentences[1]);L.toggleHard(L.sentences[2]);L.startDictation('hard');});
 assert.deepEqual(await page.evaluate(()=>window.__LH__.L.dictation.queue),[3]);out.push('PASS 无法可靠修复的句子不会混入全文听写或难句听写');
 await page.reload();await page.click('nav >> text=开始练习');if(!await page.locator('aside').first().isVisible())await page.getByTitle('素材列表').click();await page.click('aside >> text=我的素材');await page.getByRole('button',{name:/未分类.*篇/}).click();await page.locator('aside .group.cursor-pointer',{hasText:'修正部分无法识别'}).click();
 await page.getByRole('textbox',{name:'听写答案'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__LH__.L.dictation.queue),[3]);out.push('PASS 自动修复结果和过滤范围刷新后保持，不丢失学习位置');
 if(!await page.locator('aside').first().isVisible())await page.getByTitle('素材列表').click();await page.setViewportSize({width:1440,height:900});
 await upload('校验失败测试');await dialog.getByText('音文自动修正失败',{exact:true}).waitFor();
 assert.equal(await dialog.getByRole('button',{name:'开始听写',exact:true}).count(),0);assert.equal(await dialog.getByRole('button',{name:'重新自动修正',exact:true}).isEnabled(),true);out.push('PASS 真正修复失败不误报完成，可以重新自动修正');
 assert.deepEqual(errors,[]);out.push('PASS 自动修正界面无运行时错误');console.log(out.join('\n'));
 }finally{await browser.close();}
})().catch(e=>{console.error(out.join('\n'));console.error(e);process.exitCode=1});
