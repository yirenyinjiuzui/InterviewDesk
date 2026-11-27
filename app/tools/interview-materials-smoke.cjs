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
const dir = fs.mkdtempSync(path.join(workDir,'item4-profile-'));
fs.writeFileSync(path.join(dir,'settings.json'), JSON.stringify({version:2,onboarding:{schemaVersion:1,completed:true},ui:{workspace:'interview',stealth:false,lang:'zh'},asr:{backend:'cloud-realtime',realtime:{baseUrl:'wss://example.invalid/asr',model:'fixture'}}}));
const source={id:'source',name:'Source interview',createdAt:0,resumeName:'cv.md',resumeText:'I built a prototype. My old notes claim expert Python.',jdName:'company.md',jdText:'Position not confirmed. Company requires expert Python.',
 turns:[{id:'old-answer',kind:'free',label:'OLD_PRIVATE_QUESTION',text:'OLD_PRIVATE_AI',status:'done'}],segments:[{id:1,text:'OLD_PRIVATE_SPEECH',speaker:'me',startTs:0,endTs:100}],memo:'OLD_PRIVATE_MEMO',
 scripts:[{id:'old-script',title:'Original script',text:'My confirmed introduction.',collapsed:true}],personalInfo:{education:{confirmed:'CS student',pending:''},skills:{confirmed:'Expert Python in old notes',pending:'Verify level'},availability:{confirmed:'Next week',pending:'Exact date'}}};
fs.writeFileSync(path.join(dir,'sessions.json'),JSON.stringify({currentId:'empty',sessions:[{id:'empty',name:'Empty',createdAt:1,turns:[],segments:[]},source,{id:'legacy',name:'Legacy KB',createdAt:2,turns:[],kbName:'legacy.md',kbText:'Legacy resume text'}]}));
let child,ws,seq=0;const pending=new Map(), calls=[];
const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({url:req.url,body,auth:req.headers.authorization});if(body.model==='hang')return;res.setHeader('Content-Type','application/json');if(req.url.startsWith('/old')){res.statusCode=401;res.end('{}');return;}if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'你能介绍一下最近的项目吗？'}}]})+'\n\ndata: [DONE]\n\n');return;}res.end(JSON.stringify({choices:[{message:{content:'你能介绍一下最近的项目吗？'}}]}));});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(100);}throw Error('Timed out');};
const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const click=label=>ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.checkVisibility()&&(x.textContent.includes(${JSON.stringify(label)})||x.getAttribute('aria-label')===${JSON.stringify(label)}));if(!b)throw Error('button missing: '+${JSON.stringify(label)});b.click();return true;})()`);
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const debugServer=http.createServer();await new Promise(r=>debugServer.listen(0,'127.0.0.1',r));const debugPort=debugServer.address().port;await new Promise(r=>debugServer.close(r));
 child=spawn(electron,[...(process.env.MC_TEST_EXE?[]:[appRoot]),`--remote-debugging-port=${debugPort}`],{cwd:appRoot,env:{...process.env,MC_USERDATA:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const tab=await wait(async()=>{try{return (await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(x=>x.type==='page'&&x.url.includes('index.html'));}catch{return null;}});
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));ws.on('message',raw=>{const r=JSON.parse(raw);if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);}});
 await wait(()=>ev('!!window.mc && !!document.querySelector(".workspace-tabs")'));
 const patch={llm:{baseUrl:`http://127.0.0.1:${port}/old`,model:'old',apiKey:'fixture-old',answerWithVision:true,answerLang:'english'},vision:{baseUrl:`http://127.0.0.1:${port}/disabled`,model:'disabled',apiKey:'fixture-disabled',interviewEnabled:false,additional:[{baseUrl:`http://127.0.0.1:${port}/active`,model:'active',apiKey:'fixture-active',interviewEnabled:true},{baseUrl:`http://127.0.0.1:${port}/second`,model:'second',apiKey:'fixture-second',interviewEnabled:false}]}};
 await ev(`window.mc.setSettings(${JSON.stringify(patch)})`);await cmd('Page.reload');await sleep(700);await wait(()=>ev('!!document.querySelector(".workspace-tabs")'));

 const setValue=(selector,value)=>ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 const currentId=()=>ev('document.querySelector(".session-select").value');
 const select=async id=>{await setValue('.session-select',id);await sleep(100);};
 const disk=()=>ev('window.mc.loadSessions()');

 const open=async()=>{await click('面试资料');await wait(()=>ev('!!document.querySelector(".library-panel")'));};
 const expand=async()=>{await ev('document.querySelector(".session-supplement > summary").click()');await ev('document.querySelectorAll(".personal-category").forEach(el=>el.open=true)');};
 // Take the disk snapshot after legacy turns have finished their normal boot migration.
 await wait(async()=>(await disk()).sessions.find(s=>s.id==='source')?.turns[0]?.questionTranslating===false);
 const baseline=(await disk()).sessions.find(s=>s.id==='source');
 const initial=(await disk()).sessions.length;
 const height=await ev('document.querySelector(".pane-answer").getBoundingClientRect().height');
 await open();assert.deepEqual(await ev('[...document.querySelectorAll(".library-panel > .material-tabs button")].map(b=>b.textContent)'),['简历与岗位','题库']);
 assert.equal(await ev('document.querySelector(".library-panel").innerText.includes("复用资料")'),false);
 assert.equal(await ev('!!document.querySelector(".material-copy")'),false);assert.equal(await ev('document.querySelector(".session-supplement").open'),false);
 assert.equal(await ev('document.querySelector(".pane-answer").getBoundingClientRect().height'),height);await click('关闭');
 assert.deepEqual((await disk()).sessions.find(s=>s.id==='source'),baseline);
 await select('source');await open();await expand();assert.equal(await ev('document.querySelector("[data-fact=education-confirmed]").value'),'CS student');
 await setValue('[data-fact=skills-confirmed]','Unsaved edit');await click('题库');await click('简历与岗位');assert.equal(await ev('document.querySelector("[data-fact=skills-confirmed]").value'),'Unsaved edit');await click('关闭');
 assert.deepEqual((await disk()).sessions.find(s=>s.id==='source'),baseline);
 await open();await ev('document.querySelector(".material-help select").closest("details").open=true');await setValue('.material-help select','source');await expand();
 await setValue('[data-fact=skills-confirmed]','Python beginner');await setValue('[data-fact=skills-pending]','Expert level not confirmed');await setValue('[data-fact=availability-pending]','2026-12-01 start date not confirmed');await click('保存并用于本场');
 await wait(async()=>(await disk()).sessions.find(s=>s.id==='source').personalInfo.skills.confirmed==='Python beginner');
 let saved=(await disk()).sessions.find(s=>s.id==='source');assert.equal(saved.resumeText,baseline.resumeText);assert.equal(saved.jdText,baseline.jdText);assert.deepEqual(saved.scripts,baseline.scripts);assert.deepEqual(saved.turns,baseline.turns);assert.deepEqual(saved.segments,baseline.segments);assert.equal(saved.memo,baseline.memo);assert.equal(saved.personalInfo.education.confirmed,'CS student');assert.equal((await disk()).sessions.length,initial);
 assert.equal(calls.length,0,'editing and saving must not issue answer requests');
 await setValue('#current-interview-question','When can you start and how well do you know Python?');await click('生成回答');await wait(()=>calls.some(c=>c.body.messages[0].content.includes('Python beginner')));await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));
 const answer=calls.find(c=>c.body.messages[0].content.includes('Python beginner'));const prompt=JSON.stringify(answer.body.messages);assert.match(prompt,/【用户本场已确认】/);assert.match(prompt,/【待确认（不得当作个人事实）】/);assert.match(prompt,/公司／岗位参考，不是用户经历/);assert.match(prompt,/2026-12-01/);
 await wait(async()=>(await disk()).sessions.find(s=>s.id==='source').turns.length>baseline.turns.length);await cmd('Page.reload');await sleep(700);await wait(()=>ev('!!document.querySelector("#current-interview-question")'));
 assert.equal(await currentId(),'source');saved=(await disk()).sessions.find(s=>s.id==='source');assert.equal(saved.personalInfo.skills.confirmed,'Python beginner');assert.equal(saved.scripts[0].text,baseline.scripts[0].text);
 await open();await cmd('Emulation.setDeviceMetricsOverride',{width:640,height:700,deviceScaleFactor:1,mobile:false});await ev('document.documentElement.dataset.theme="light"');await sleep(100);let img=await cmd('Page.captureScreenshot');fs.writeFileSync(path.join(dir,'two-tabs.png'),Buffer.from(img.data,'base64'));
 assert.equal(await ev('document.querySelector(".library-panel").scrollWidth<=document.querySelector(".library-panel").clientWidth'),true);await expand();await ev('document.querySelector(".material-dialog").scrollTop=10000');img=await cmd('Page.captureScreenshot');fs.writeFileSync(path.join(dir,'optional-session-details.png'),Buffer.from(img.data,'base64'));assert.equal(await ev('document.querySelector(".settings-actions button").checkVisibility()'),true);await click('关闭');
 await cmd('Emulation.setDeviceMetricsOverride',{width:360,height:600,deviceScaleFactor:1,mobile:false});await open();assert.equal(await ev('document.querySelector(".library-panel").scrollWidth<=document.querySelector(".library-panel").clientWidth'),true);await ev('document.documentElement.dataset.theme="dark"');img=await cmd('Page.captureScreenshot');fs.writeFileSync(path.join(dir,'materials-dark-narrow.png'),Buffer.from(img.data,'base64'));
 await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await wait(()=>ev('!document.querySelector(".material-dialog")'));
 console.log(JSON.stringify({ok:true,profile:dir,checks:['only two material tabs','reuse controls removed','supplement collapsed by default','modal keeps answer height','existing data preserved on open','old personal facts remain editable','tabs retain unsaved edits','close cancels edits','single save applies materials and facts','old scripts dialogue and memo preserved','no duplicate session created','local editing without answer requests','confirmed and pending prompt facts','reload persistence','640px scrolling','360px dark layout','Escape closes modal']}));

 }finally{ws?.close();if(child?.pid)try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{}server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
