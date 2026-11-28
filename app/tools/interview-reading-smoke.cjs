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
const dir = fs.mkdtempSync(path.join(workDir,'item3-profile-'));
fs.writeFileSync(path.join(dir,'settings.json'), JSON.stringify({version:2,onboarding:{schemaVersion:1,completed:true},ui:{workspace:'interview',stealth:false,lang:'zh'},asr:{backend:'cloud-realtime',realtime:{baseUrl:'wss://example.invalid/asr',model:'fixture'}}}));
const legacyTurns=Array.from({length:30},(_,i)=>({id:'old-'+i,kind:'free',label:'Old question '+i,text:('Legacy full answer '+i+'\n').repeat(6),status:'done'}));
fs.writeFileSync(path.join(dir,'sessions.json'),JSON.stringify({currentId:'reading',sessions:[{id:'reading',name:'Reading',createdAt:0,turns:[]},{id:'legacy',name:'Legacy',createdAt:1,turns:legacyTurns}]}));
let child,ws,seq=0;const pending=new Map(), calls=[];
const failGloss=new Set();
let scrollResponse;
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push({url:req.url,body,auth:req.headers.authorization});
 const translation=body.messages[0].content.includes('翻译引擎');
 const memo=body.messages[0].content.includes('备忘维护器');
 const prompt=String(body.messages.at(-1).content);
 if(translation){
   if(prompt.includes('fail gloss')&&!failGloss.has(prompt)){failGloss.add(prompt);res.statusCode=503;res.end('temporary fixture failure');return;}
   setTimeout(()=>{if(!res.destroyed){if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'中文释义：'+prompt}}]})+'\n\ndata: [DONE]\n\n');}else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'中文释义：'+prompt}}]}));}}},1400);return;
 }
 if (!scrollResponse && body.stream && !memo && prompt.includes('Historical scroll question?')) {
   scrollResponse = res;
   res.setHeader('Content-Type','text/event-stream');
   writeScrollChunk('First');
   return;
 }
 const answer=memo?'Memo of AI suggestions.':`Answer from ${body.model}. I built a prototype. This is a complete spoken answer.\n\n中文翻译：\n我开发了一个原型。这是完整的口头回答。`;
 if(body.stream){res.setHeader('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{delta:{content:answer.slice(0,24)}}]})+'\n\n');if(prompt.includes('展开：'))return;setTimeout(()=>{if(!res.destroyed)res.end('data: '+JSON.stringify({choices:[{delta:{content:answer.slice(24)}}]})+'\n\ndata: [DONE]\n\n');},350);return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:answer}}]}));
});
function writeScrollChunk(label) {
 const text = (label + ' section of the streamed answer.\n').repeat(35);
 scrollResponse.write('data: ' + JSON.stringify({choices:[{delta:{content:text}}]}) + '\n\n');
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(100);}throw Error('Timed out');};
const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const click=label=>ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(!b)throw Error('button missing');b.click();return true;})()`);
(async()=>{try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const debugServer=http.createServer();await new Promise(r=>debugServer.listen(0,'127.0.0.1',r));const debugPort=debugServer.address().port;await new Promise(r=>debugServer.close(r));
 child=spawn(electron,[...(process.env.MC_TEST_EXE?[]:[appRoot]),`--remote-debugging-port=${debugPort}`],{cwd:appRoot,env:{...process.env,MC_USERDATA:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 const tab=await wait(async()=>{try{return (await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(x=>x.type==='page'&&x.url.includes('index.html'));}catch{return null;}});
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));ws.on('message',raw=>{const r=JSON.parse(raw);if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result);}});
 await wait(()=>ev('!!window.mc && !!document.querySelector(".workspace-tabs")'));
 const patch={llm:{baseUrl:`http://127.0.0.1:${port}/text`,model:'text',apiKey:'fixture-text',answerWithVision:false,answerLang:'english'},vision:{baseUrl:`http://127.0.0.1:${port}/disabled`,model:'disabled',apiKey:'fixture-disabled',interviewEnabled:false,additional:[{baseUrl:`http://127.0.0.1:${port}/active`,model:'active',apiKey:'fixture-active',interviewEnabled:true},{baseUrl:`http://127.0.0.1:${port}/second`,model:'second',apiKey:'fixture-second',interviewEnabled:true}]}};
 await ev(`window.mc.setSettings(${JSON.stringify(patch)})`);await cmd('Page.reload');await sleep(700);await wait(()=>ev('!!document.querySelector(".workspace-tabs")'));

 const setValue=(selector,value)=>ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
 const question=async text=>{await setValue('#current-interview-question',text);await ev(`document.querySelector('#current-interview-question').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))`);};
 const inTurn=(index,label)=>ev(`(()=>{const el=document.querySelectorAll('.session .turn')[${index}];const b=[...el.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(label)}));if(!b)throw Error('turn action missing');b.click();})()`);
 const answers=()=>calls.filter(c=>!c.body.messages[0].content.includes('翻译引擎')&&!c.body.messages[0].content.includes('备忘维护器'));
 const translations=()=>calls.filter(c=>c.body.messages[0].content.includes('翻译引擎'));
 const bodyText=index=>ev(`document.querySelectorAll('.session .turn-body')[${index}].innerText`);
 const reload=async()=>{await cmd('Page.reload');await sleep(700);await wait(()=>ev('!!document.querySelector("#current-interview-question")'));};
 const select=async id=>{await setValue('.session-select',id);await sleep(100);};
 assert.equal(await ev('document.querySelectorAll(".question-gloss").length'),0);
 await ev('document.querySelector(".session-more").open=true');await ev('document.querySelector(".reading-controls input[type=checkbox]").click()');await ev('document.querySelector(".session-more").open=false');
 await question('Parallel English question?');await wait(()=>answers().length===1&&translations().length===1);
 await wait(()=>ev('document.querySelector(".session .turn-body").innerText.includes("Answer from")'));
 assert.match(await ev('document.querySelector(".question-gloss").innerText'),/翻译中/,'slow translation must not block answer deltas');
 await wait(()=>ev('document.querySelector(".question-gloss").innerText.includes("中文释义：")'));
 await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));
 assert.match(answers()[0].body.messages[0].content,/用【英文】输出/);assert.equal(await ev('document.querySelector(".reading-question").innerText'),'Parallel English question?');
 const original=await bodyText(0);
 await inTurn(0,'更短');await wait(()=>answers().length===2);await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));
 assert.match(answers()[1].body.messages.at(-1).content,/更短：/);assert.ok(answers()[1].body.messages.at(-1).content.includes(original));assert.equal(await bodyText(0),original);assert.equal(translations().length,1,'revision reuses existing gloss');
 await inTurn(0,'展开');await wait(()=>answers().length===3);await wait(()=>ev('document.querySelectorAll(".session .turn-body")[2].innerText.includes("Answer from")'));
 await inTurn(2,'停');await wait(()=>ev('document.querySelectorAll(".session .turn-head")[2].innerText.includes("已停止")'));assert.equal(await bodyText(0),original);
 await inTurn(1,'换个说法');await wait(()=>answers().length===4);await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));assert.match(answers()[3].body.messages.at(-1).content,/换个说法：/);
 await question('fail gloss question?');await wait(()=>answers().length===5);await wait(()=>ev('document.querySelectorAll(".question-gloss")[4].innerText.includes("释义失败")'));await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));assert.match(await bodyText(4),/complete spoken answer/);
 await inTurn(4,'重试释义');await wait(()=>ev('document.querySelectorAll(".question-gloss")[4].innerText.includes("中文释义：")'));assert.equal(answers().length,5);
 await inTurn(0,'固定为讲稿');await wait(()=>ev('document.querySelectorAll(".pinned-script").length===1'));
 await ev('document.querySelector(".session-more").open=true');await click('添加讲稿');await setValue('.script-editor input','My confirmed introduction');await setValue('.script-editor textarea','I am a student. I built a search prototype.');await click('保存并固定');
 await wait(()=>ev('document.querySelectorAll(".pinned-script").length===2'));await ev('document.querySelector(".script-head button").click()');
 await wait(()=>ev('(async()=>{const f=await window.mc.loadSessions();return f.sessions.find(s=>s.id==="reading").scripts?.[0].collapsed===true})()'));
 await ev(`document.querySelector('.session-bar button[title*="保留固定讲稿"]').click()`);await wait(()=>ev('document.querySelectorAll(".session .turn").length===0'));
 assert.equal(await ev('document.querySelectorAll(".pinned-script").length'),2);await sleep(500);await reload();
 assert.equal(await ev('document.querySelectorAll(".pinned-script").length'),2);assert.equal(await ev('document.querySelector(".script-head button").getAttribute("aria-expanded")'),'false');assert.equal(await ev('document.querySelector(".reading-controls input").checked'),true);
 await select('legacy');assert.equal(await ev('document.querySelectorAll(".session .turn").length'),30);assert.equal(await ev('document.querySelector(".reading-controls input").checked'),false);
 const feed = 'document.querySelector(".pane-answer .session")';
 const jump = 'document.querySelector(".pane-answer .jump-bottom")';
 const atBottom = () => ev(`Math.abs(${feed}.scrollHeight - ${feed}.clientHeight - ${feed}.scrollTop) <= 1`);
 await question('Historical scroll question?');
 await wait(()=>ev(`${feed}.innerText.includes('First section')`));
 await wait(atBottom);
 const readingTop = await ev(`(()=>{const el=${feed};el.scrollTop=Math.floor(el.scrollTop/2);return el.scrollTop;})()`);
 await wait(()=>ev(`!!${jump}`));
 writeScrollChunk('Second');
 await wait(()=>ev(`${feed}.innerText.includes('Second section')`));
 assert.equal(await ev(`${feed}.scrollTop`),readingTop,'a new chunk preserves the reading position');
 assert.ok(await ev(`(()=>{const b=${jump}.getBoundingClientRect();return ${jump}.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`),'jump button is visible and clickable');
 await ev(`${jump}.click()`);
 await wait(atBottom);
 const afterJump = await ev(`${feed}.scrollTop`);
 writeScrollChunk('Third');
 await wait(()=>ev(`${feed}.innerText.includes('Third section')`));
 await wait(atBottom);
 assert.ok(await ev(`${feed}.scrollTop`) > afterJump,'later content scrolls into view');
 assert.equal(await ev(`!!${jump}`),false);
 scrollResponse.end('data: '+JSON.stringify({choices:[{delta:{content:'\n中文翻译：\n这是测试回答。'}}]})+'\n\ndata: [DONE]\n\n');
 await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));
 await select('reading');await ev('window.mc.setSettings({llm:{answerWithVision:true}})');await reload();
 const beforeAnswers=answers().length,beforeTranslations=translations().length;await question('Two model reading question?');await wait(()=>answers().length===beforeAnswers+2);await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));await wait(()=>ev('document.querySelectorAll(".question-gloss").length===2&&[...document.querySelectorAll(".question-gloss")].every(el=>el.innerText.includes("中文释义："))'));
 assert.equal(translations().length,beforeTranslations+1);assert.deepEqual(answers().slice(-2).map(c=>c.body.model).sort(),['active','second']);
 await inTurn(1,'更短');await wait(()=>answers().length===beforeAnswers+3);assert.equal(answers().at(-1).body.model,'second');assert.ok(answers().at(-1).body.messages.at(-1).content.includes('Answer from second.'));
 await ev('window.mc.setSettings({llm:{answerLang:"chinese"}})');await reload();const beforeChinese=answers().length;await question('请介绍项目？');await wait(()=>answers().length===beforeChinese+2);assert.ok(answers().slice(-2).every(c=>c.body.messages[0].content.includes('用【中文】输出')));
 await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));
 // A revision of the earlier English answer must retain English after settings change.
 await inTurn(0,'换个说法');await wait(()=>answers().length===beforeChinese+3);assert.match(answers().at(-1).body.messages[0].content,/用【英文】输出/);
 await cmd('Emulation.setDeviceMetricsOverride',{width:640,height:700,deviceScaleFactor:1,mobile:false});await sleep(150);const screenshot=await cmd('Page.captureScreenshot');fs.writeFileSync(path.join(dir,'reading.png'),Buffer.from(screenshot.data,'base64'));
 assert.equal(await ev('document.querySelector(".pane-answer").scrollWidth<=document.querySelector(".pane-answer").clientWidth'),true);
 const beforeLegacyRewrite=answers().length;await select('legacy');await inTurn(0,'更短');await wait(()=>answers().length===beforeLegacyRewrite+1);assert.equal(answers().at(-1).body.model,'text');assert.equal(answers().at(-1).auth,'Bearer fixture-text');
 // Session history deletion requires an explicit second action on the same session.
 await wait(()=>ev('document.querySelectorAll(".session .cursor").length===0'));
 await select('reading');
 const deleteMenu=async()=>{await ev('document.querySelector(".session-more").open=true');await click('删除会话');};
 const deleteGroup='document.querySelector("[aria-label=\\"确认删除会话\\"]")';
 const persisted=()=>ev('(async()=>{const f=await window.mc.loadSessions();return f.sessions.map(s=>s.id).sort()})()');
 await deleteMenu();await wait(()=>ev(`!!${deleteGroup}`));
 assert.ok((await ev(`${deleteGroup}.innerText`)).includes(await ev('document.querySelector(".session-select").selectedOptions[0].textContent')));
 assert.deepEqual(await persisted(),['legacy','reading']);
 await ev(`${deleteGroup}.querySelector('button').click()`);await wait(()=>ev(`!${deleteGroup}`));
 assert.deepEqual(await persisted(),['legacy','reading']);
 await deleteMenu();await select('legacy');await wait(()=>ev(`!${deleteGroup}`));assert.deepEqual(await persisted(),['legacy','reading']);
 await select('reading');await deleteMenu();await click('确认删除');
 await wait(async()=>JSON.stringify(await persisted())==='["legacy"]');
 await reload();assert.equal(await ev('document.querySelector(".session-select").value'),'legacy');
 console.log(JSON.stringify({ok:true,profile:dir,answers:answers().length,translations:translations().length,checks:['parallel translation and streaming answer','complete original question','all three selected-answer revisions','rewrite cancellation keeps original','translation failure and independent retry','pin and paste scripts','clear preserves scripts','collapse and preference persist','old session compatibility','stream pauses on scroll up, jump returns to bottom and follows later chunks','two models share one translation','revision keeps selected model','Chinese answers','revision keeps original language','legacy text answer keeps text account after mode switch','Ctrl+Enter','640px layout','session deletion confirmation, cancel, switch and persistence']}));
 }finally{ws?.close();if(child?.pid)try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});}catch{}server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
