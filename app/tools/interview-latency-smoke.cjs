const fs = require('fs');
const path = require('path');
const http = require('http');
const {spawn,execFileSync} = require('child_process');
const appRoot = path.resolve(__dirname,'..');
const electron = process.env.MC_TEST_EXE || require(path.join(appRoot,'node_modules/electron'));
const WebSocket = require(path.join(appRoot,'node_modules/ws'));
const assert = require('assert/strict');
const workDir = path.join(appRoot,'..','work');
fs.mkdirSync(workDir,{recursive:true});
const dir = fs.mkdtempSync(path.join(workDir,'item5-profile-'));
fs.writeFileSync(path.join(dir,'settings.json'), JSON.stringify({version:2,onboarding:{schemaVersion:1,completed:true},ui:{workspace:'interview',stealth:false,lang:'zh'},asr:{backend:'cloud-realtime',realtime:{baseUrl:'ws://127.0.0.1:1/asr',model:'fixture'}}}));
let child,ws,mainWs,mainSeq=0,seq=0;const pending=new Map(), calls=[];
let finishShot;
const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({url:req.url,body,auth:req.headers.authorization});if(body.model==='hang'||(String(body.messages.at(-1).content).includes('pending fragment')&&!String(body.messages.at(-1).content).includes('finished detail')&&!body.messages[0].content.includes('备忘维护器')))return;res.setHeader('Content-Type','application/json');if(req.url.startsWith('/old')){res.statusCode=401;res.end('{}');return;}if (body.stream && Array.isArray(body.messages.at(-1).content)) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.write('data: {"choices":[{"delta":{"content":"截图首段"}}]}\n\n');
  finishShot = () => res.end('data: {"choices":[{"delta":{"content":"和末段"}}]}\n\ndata: [DONE]\n\n');
  return;
}if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'你能介绍一下最近的项目吗？'}}]})+'\n\ndata: [DONE]\n\n');return;}res.end(JSON.stringify({choices:[{message:{content:'你能介绍一下最近的项目吗？'}}]}));});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(100);}throw Error('Timed out');};
const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const click=label=>ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(!b)throw Error('button missing');b.click();return true;})()`);
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const debugServer=http.createServer();await new Promise(r=>debugServer.listen(0,'127.0.0.1',r));const debugPort=debugServer.address().port;await new Promise(r=>debugServer.close(r));
 const nodePortServer=http.createServer();await new Promise(r=>nodePortServer.listen(0,'127.0.0.1',r));const nodePort=nodePortServer.address().port;await new Promise(r=>nodePortServer.close(r));
 child=spawn(electron,[...(process.env.MC_TEST_EXE?[]:[appRoot]),`--remote-debugging-port=${debugPort}`,`--inspect=127.0.0.1:${nodePort}`],{cwd:appRoot,env:{...process.env,MC_USERDATA:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const tab=await wait(async()=>{try{return (await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(x=>x.type==='page'&&x.url.includes('index.html'));}catch{return null;}});
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));ws.on('message',raw=>{const r=JSON.parse(raw);if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);}});
 await wait(()=>ev('!!window.mc && !!document.querySelector(".workspace-tabs")'));
 const patch={llm:{baseUrl:`http://127.0.0.1:${port}/old`,model:'old',apiKey:'fixture-old',answerWithVision:true,answerLang:'chinese'},vision:{baseUrl:`http://127.0.0.1:${port}/disabled`,model:'disabled',apiKey:'fixture-disabled',interviewEnabled:false,additional:[{baseUrl:`http://127.0.0.1:${port}/active`,model:'active',apiKey:'fixture-active',interviewEnabled:true},{baseUrl:`http://127.0.0.1:${port}/second`,model:'second',apiKey:'fixture-second',interviewEnabled:false}]}};
 await ev(`window.mc.setSettings(${JSON.stringify(patch)})`);await cmd('Page.reload');await sleep(700);await wait(()=>ev('!!document.querySelector(".workspace-tabs")'));

 const mainTarget=await wait(async()=>{try{return (await(await fetch(`http://127.0.0.1:${nodePort}/json`)).json())[0];}catch{return null;}});
 mainWs=new WebSocket(mainTarget.webSocketDebuggerUrl);await new Promise(r=>mainWs.once('open',r));
 const mainEval=expression=>new Promise((resolve,reject)=>{const id=++mainSeq;const handle=raw=>{const msg=JSON.parse(raw);if(msg.id!==id)return;mainWs.off('message',handle);if(msg.result?.exceptionDetails)reject(Error(JSON.stringify(msg.result.exceptionDetails)));else resolve(msg.result);};mainWs.on('message',handle);mainWs.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});

 const sid=await ev('(async()=>{const file=await window.mc.loadSessions();return file.currentId})()');
 assert.ok(sid);
 // Known rejected frames are still counted at IPC ingress, separately per speaker.
 await ev(`(() => {
   window.mc.captureChannel('them', true, ${JSON.stringify(sid)});
   window.mc.sendPcm(new Float32Array(1600).buffer, Date.now(), 'them', ${JSON.stringify(sid)});
   window.mc.captureStopped(${JSON.stringify(sid)});
   for (const speaker of ['them','me']) {
     window.mc.captureChannel(speaker, false, ${JSON.stringify(sid)});
     window.mc.sendPcm(new Float32Array(1600).buffer, Date.now(), speaker, ${JSON.stringify(sid)});
     window.mc.captureChannel(speaker, false, ${JSON.stringify(sid)});
   }
 })()`);
 const now=Date.now();
 const emit=async event=>{
   const sessionId=await ev('document.querySelector(".session-select").value');
   return mainEval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).webContents.send('asr:event',${JSON.stringify({sessionId,...event})})`);
 };
 assert.match(await ev('document.querySelector(".status-hud").innerText'),/转录首字 —/);
 await emit({kind:'partial',speaker:'them',text:'测试首字',speechStartTs:now-1000,firstTextTs:now-700});
 await wait(()=>ev('document.querySelector(".status-hud").innerText.includes("0.30s")'));
 await emit({kind:'segment',id:1,text:'请介绍项目？',speaker:'them',timings:{speechStartTs:now-1000,speechEndTs:now-200,inferStartTs:now-200,inferEndTs:now,firstTextTs:now-700,timingValid:true,timingKind:'stream'}});
 await wait(()=>ev('document.querySelector(".bubble-meta")?.innerText.includes("首字 0.30s")'));
 await click('生成回答');await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0&&document.querySelectorAll(".session .turn").length===1'));
 const stored=await ev('(async()=>{await new Promise(r=>setTimeout(r,500));const f=await window.mc.loadSessions();return f.sessions.find(s=>s.id===f.currentId).turns[0]})()');assert.ok(stored.firstTokenMs>=0);assert.ok(stored.completedMs>=stored.firstTokenMs);
 assert.doesNotMatch(await ev('document.querySelector(".answer-latency").innerText'),/—/);
 // Use a local image fixture in place of capturing the desktop.
 await mainEval(`(() => {
   const ipc = process.mainModule.require('electron').ipcMain;
   ipc.removeHandler('region:pick');
   ipc.handle('region:pick', async () => { await new Promise(r=>setTimeout(r,80)); return 'data:image/png;base64,AAAA'; });
 })()`);
 await click('📷');
 await wait(()=>ev('[...document.querySelectorAll(".turn-body")].some(el=>el.innerText.includes("截图首段") && el.querySelector(".cursor"))'));
 finishShot();
 await wait(()=>ev('[...document.querySelectorAll(".answer-latency")].some(el=>el.innerText.includes("截图就绪到发送") && !el.innerText.includes("—"))'));
 await sleep(700);
 const session=await ev(`(async()=>{const f=await window.mc.loadSessions();return f.sessions.find(s=>s.id===f.currentId)})()`);
 const shot=session.turns.find(t=>t.kind==='vision');
 assert.equal(shot.text,'截图首段和末段');
 assert.ok(shot.imageReadyAt-shot.captureStartedAt>=70);
 assert.ok(shot.requestStartedAt>=shot.imageReadyAt && shot.firstTokenMs>=0);
 const trace=session.interviewTrace;
 for(const speaker of ['them','me']) assert.ok(trace.some(e=>e.kind==='frames' && e.speaker===speaker && e.count===1 && e.forwarded===0));
 assert.ok(trace.some(e=>e.kind==='frames' && e.speaker==='them' && e.count===1 && e.forwarded===1));
 const trigger=trace.find(e=>e.kind==='trigger' && e.source==='manual');
 assert.equal(trigger.batchId, stored.batchId);
 const final=trace.find(e=>e.kind==='final' && e.speechStartTs===trigger.speechStartTs);
 assert.ok(final && final.continuous===false && trigger.at>=final.at);
 await emit({kind:'segment',id:2,text:'invalid timestamp',speaker:'them',timings:{speechStartTs:0,speechEndTs:0,inferStartTs:0,inferEndTs:now,timingValid:false}});
 await wait(()=>ev('document.querySelector(".status-hud").innerText.includes("定稿 —")'));
 await cmd('Emulation.setDeviceMetricsOverride',{width:640,height:700,deviceScaleFactor:1,mobile:false});await sleep(100);const img=await cmd('Page.captureScreenshot');fs.writeFileSync(path.join(dir,'latency.png'),Buffer.from(img.data,'base64'));
 console.log(JSON.stringify({ok:true,profile:dir,checks:['unknown ASR timing','known first text 300ms','final latency label','answer first and completion persisted','invalid timing stays unknown','640px HUD']}));
 }finally{mainWs?.close();ws?.close();if(child?.pid)try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{}server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
