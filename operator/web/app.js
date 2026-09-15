const $ = s => document.querySelector(s);
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names = { 'codex-a':'Codex A', 'codex-b':'Codex B', zcode:'ZCode', mac:'Mac' };
const statusNames = {running:'运行中',starting:'正在启动',awaitingApproval:'需要处理',completed:'已完成',idle:'已完成',failed:'失败',interrupted:'已停止',rejected:'已拒绝',unknown:'状态未知',unverified:'旧记录',lost:'控制已丢失',cancelling:'正在停止'};
const views = [['overview','工作总览'],['tasks','任务'],['channels','Bridge A / B'],['usage','Token 用量'],['concurrency','并发与调度'],['providers','Agent 设置'],['profile','自动化规则'],['appearance','显示设置'],['memory','Memory'],['recovery','系统维护'],['logs','日志与诊断'],['advanced','高级信息']];
const navGroups = [{title:'日常工作',items:['overview','tasks','channels','usage']},{title:'运行设置',items:['concurrency','providers','profile','appearance'],collapse:true},{title:'维护与诊断',items:['memory','recovery','logs','advanced'],collapse:true}];
let stateFresh=false,authExpired=false,lastStateRead=0,refreshPromise=null,refreshTimer=null,slowTimer=null,settingsConflict=false,saveFeedback='',taskPage=0,taskBusy=false,taskInvalid=false,dialogMode='',taskFormDirty=false,returnFocus=null;
let usageData=null,usageError='',usageLoading=false,usageController=null,usageSequence=0,usageUpdated=0,usagePage=0,usageFilters={days:'7',provider:'',model:''},usageLoadedKey='',usageModels=new Set(),modelCatalog={};
let houseLoading=false,profileLoading=false,houseEditVersion=0,profileEditVersion=0,logSequence=0,memoryData=null,memoryLoading=false,memoryFilter='all',rulesDoc=null;
const taskIdentity=t=>JSON.stringify([t?.provider,t?.ref,t?.turnId,t?.pendingApproval?.requestId,t?.pendingApproval||null]);
const liveTask=t=>t?.live===true&&['starting','running','awaitingApproval','cancelling','unknown'].includes(t.status);
const number=n=>typeof n==='number'&&Number.isFinite(n)?n.toLocaleString('zh-CN'):'未知';
const taskStamp=v=>{const n=Number(v);if(Number.isFinite(n))return n;const d=Date.parse(v);return Number.isFinite(d)?d:null;};
const plain=v=>typeof v==='string'?v:v==null?'未提供':JSON.stringify(v,null,2);

const sectionFor = {concurrency:'并发与调度',providers:'执行器设置',channels:'连接通道',memory:'记忆与清理',recovery:'启动与恢复',appearance:'显示设置'};
let houseDirty=false,profileDirty=false,profileDraft=null,houseFeedback='';
const hasDirty=()=>dirty||houseDirty||profileDirty;
let state=null,catalog=null,view='overview',draft=null,settingsDoc=null,dirty=false,houseDoc=null,profileDoc=null,activeTask=null,search='',filterProvider='',filterStatus='live',taskSearch='',timer=null,toastTimer=null,refreshing=false;
const fragment = new URLSearchParams(location.hash.slice(1));
let token=fragment.get('token') || sessionStorage.getItem('panelToken') || '';
if(fragment.has('token')){sessionStorage.setItem('panelToken',token);history.replaceState(null,'',location.pathname);}
const getAt=(v,k)=>k.split('.').reduce((a,b)=>a?.[b],v);
function putAt(v,k,x){const p=k.split('.'),last=p.pop();p.reduce((a,b)=>a[b],v)[last]=x;}
function when(v,timeZone){if(!v)return '—';const d=new Date(v);if(Number.isNaN(d.getTime()))return '—';try{return d.toLocaleString('zh-CN',{...(timeZone?{timeZone,year:'numeric'}:{}),month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}catch{return d.toISOString()+'（时区未识别）';}}
function duration(ms){if(!Number.isFinite(ms)||ms<0)return '—';const s=Math.floor(ms/1000);if(s<60)return s+' 秒';if(s<3600)return Math.floor(s/60)+' 分 '+s%60+' 秒';return Math.floor(s/3600)+' 小时 '+Math.floor(s%3600/60)+' 分';}
function bytes(n){return Number.isFinite(n)?(n/1024/1024/1024).toFixed(1)+' 吉字节':'—';}
function toast(text,error=false){clearTimeout(toastTimer);$('#toast').textContent=text;$('#toast').className=error?'error':'';$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,error?8500:5000);}
async function api(path,options={}){
  const controller=new AbortController(),external=options.signal;
  const abort=()=>controller.abort();external?.addEventListener('abort',abort,{once:true});
  if(external?.aborted)abort();
  const timeout=setTimeout(abort,options.method==='POST'?20000:12000);
  try{
    const r=await fetch('/api/'+path,{...options,signal:controller.signal,headers:{'x-panel-token':token,...(options.body?{'content-type':'application/json'}:{}),...options.headers},cache:'no-store'});
    if(r.status===401){authExpired=true;stateFresh=false;showConnection('认证已过期，请从桌面重新打开控制台。',true);syncTaskDialog();throw Object.assign(new Error('窗口认证已过期，请从桌面重新打开控制台。'),{status:401});}
    let data;try{data=await r.json();}catch{throw new Error('后台返回的数据无法读取，请稍后重试。');}
    if(!r.ok)throw Object.assign(new Error(data.error||'操作未完成，请重试。'),{status:r.status});
    return data;
  }catch(err){if(err.name==='AbortError')throw Object.assign(new Error(options.method==='POST'?'等待操作回执超时，结果未知。请刷新核对后再决定，勿重复提交。':'读取超时，正在保留上次数据。请检查本机后台后重试。'),{status:0});throw err;}
  finally{clearTimeout(timeout);external?.removeEventListener('abort',abort);}
}

const post=(path,value)=>api(path,{method:'POST',body:JSON.stringify(value)});
function pill(status){const good=['running','completed','idle'].includes(status),bad=['failed','lost'].includes(status);return `<span class="pill ${good?'good':bad?'bad':'warn'}">${e(statusNames[status]||status)}</span>`;}
function pageHead(title,desc,actions=''){return `<div class="page-head"><div><div class="eyebrow">本机管理</div><h1>${e(title)}</h1><p>${e(desc)}</p></div>${actions?`<div class="actions">${actions}</div>`:''}</div>`;}
function operationBox(){const op=state?.operation;if(!op)return '<div id="operation-status"></div>';return `<div id="operation-status" class="operation ${op.status==='failed'?'error':''}"><strong>${e(op.name)} · ${op.status==='running'?'进行中':op.status==='completed'?'已完成':'未完成'}</strong><p>${op.error?e(op.error):op.status==='running'?'操作在后台执行。可以切换页面，完成后结果会保留。':'结束时间：'+e(when(op.endedAt))}</p>${op.result?`<details><summary>查看操作结果</summary><pre>${e(JSON.stringify(op.result,null,2))}</pre></details>`:''}</div>`;}
function controlNotice(){if(state?.runtime?.legacy)return `<div class="banner warning"><strong>已连接现有版本，保护正在等待的任务</strong>任务状态与审批已可使用。并发和执行器设置可先保存，需在任务空闲后接入管理版本才会生效。<p>${e(state.runtime.coverage)}</p><button class="text-button" data-nav="recovery">查看版本接入</button></div>`;if(state?.controlConnected)return '';return `<div class="banner warning"><strong>本机管理接口尚未连接</strong>桥接和通道状态仍可查看。实时任务数暂不作推断，调度设置只有在管理版本连接并确认后才显示为已生效。<p>${e(state?.controlError||'正在等待运行时连接。')}</p></div>`;}
function taskRowActions(t){
  const terminal=['completed','idle','failed','interrupted','rejected','lost'].includes(t.status),buttons=[];
  buttons.push(`<button data-task="${e(t.ref)}" data-provider="${e(t.provider)}">详情</button>`);
  if(t.live&&t.pendingApproval){
    if(t.pendingApproval?.details?.requiresContent)buttons.push(`<button class="primary" data-task="${e(t.ref)}" data-provider="${e(t.provider)}">填写并处理</button>`);
    else{buttons.push(`<button class="primary" data-quick-task="approve" data-task-ref="${e(t.ref)}" data-provider="${e(t.provider)}">接受</button>`);buttons.push(`<button class="danger" data-quick-task="reject" data-task-ref="${e(t.ref)}" data-provider="${e(t.provider)}">拒绝</button>`);}
  }else if(t.live&&['starting','running'].includes(t.status))buttons.push(`<button class="danger" data-quick-task="cancel" data-task-ref="${e(t.ref)}" data-provider="${e(t.provider)}">停止</button>`);
  if(!t.live||terminal)buttons.push(`<button class="danger" data-quick-task="dismiss" data-task-ref="${e(t.ref)}" data-provider="${e(t.provider)}">删除</button>`);
  return `<div class="task-actions">${buttons.join('')}</div>`;
}
function taskTable(rows,compact=false){
  if(!rows.length)return '<div class="empty"><strong>'+ (state?.controlConnected?'当前没有符合条件的任务':'尚无已核验任务')+'</strong>'+(state?.controlConnected?'可以调整筛选条件；新任务会自动出现。':'等待运行时提供状态，历史记录不计作当前任务。')+'</div>';
  const count=compact?rows.length:50,total=rows.length,pages=Math.ceil(total/count);
  if(!compact)taskPage=Math.min(taskPage,Math.max(0,pages-1));
  const shown=compact?rows:rows.slice(taskPage*count,(taskPage+1)*count);
  return '<div class="table-wrap"><table class="task-table"><colgroup><col class="col-task"><col class="col-provider"><col class="col-time"><col class="col-action"></colgroup><thead><tr><th>任务 / 最新进展</th><th>执行器</th><th>状态</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>'+shown.map(t=>`<tr data-key="${e(t.provider+':'+t.ref)}"><td><div class="task-title" title="${e(t.description||t.title)}">${e(t.title||'未命名任务')}</div><div class="sub">${e(t.model||'模型未提供')} · ${e(t.cwd||t.project||'项目未提供')}</div>${t.pendingApproval?'<div class="request-hint">'+e(requestExplanation(t).title)+'</div>':''}</td><td>${e(names[t.provider]||t.provider||'未提供')}<div class="sub">${t.live?'当前实例':'历史待核验'}</div></td><td>${pill(t.status)}<div class="sub">${e(when(t.updatedAt))}</div></td><td>${taskRowActions(t)}</td></tr>`).join('')+'</tbody></table></div>'+(!compact?`<div class="pagination"><span>共 ${total} 条 · 每页最多 50 条</span><div><button data-task-page="-1" ${taskPage===0?'disabled':''}>上一页</button><span>${taskPage+1} / ${pages}</span><button data-task-page="1" ${taskPage>=pages-1?'disabled':''}>下一页</button></div></div>`:'');
}

function channelRows(detailed=false){
  if(!state?.channels?.length)return '<div class="empty"><strong>通道状态未知</strong>后台尚未提供通道探测结果。</div>';
  return state.channels.map(c=>{const known=typeof c.connected==='boolean',label=c.recovering?'正在恢复':known?(c.connected?'连接正常':'连接异常'):'尚未核验';return `<div class="connection-row" data-key="channel-${e(c.lane)}"><div><strong>${e(c.name|| (c.lane==='a'?'Bridge A':'Bridge B'))}</strong> <span class="pill ${known?(c.connected?'good':'bad'):'warn'}">${label}</span><p>${c.connected?'可访问本机桥接 · '+(c.ownerAlive===true?'计划任务守护在线':'守护归属待核验'):e(c.error||'尚无可靠探测结果')}</p>${detailed?`<details><summary>进程、运行时间与实际连接参数</summary><dl class="definition horizontal"><div><dt>进程</dt><dd>${e(c.runtimePid||'未知')}</dd></div><div><dt>运行时长</dt><dd>${e(duration(c.uptimeSeconds==null?NaN:c.uptimeSeconds*1000))}</dd></div><div><dt>实际代理</dt><dd class="mono">${e(c.proxy===undefined?'未知':c.proxy||'直接连接')}</dd></div><div><dt>健康探针</dt><dd class="mono">${e(c.healthBase||'未提供')}</dd></div></dl></details>`:''}</div><div class="right">${detailed?`<button data-maintenance="channelStart" data-lane="${e(c.lane)}">启动</button><button data-maintenance="channelRestart" data-lane="${e(c.lane)}">重新连接</button><button class="text-button danger" data-maintenance="channelStop" data-lane="${e(c.lane)}">停用</button>`:'<button class="text-button" data-nav="channels">管理通道</button>'}</div></div>`;}).join('');
}

function overview(){
  const h=state.bridge||{},r=state.runtime,counts=r?.counts,all=state.tasks||[],current=all.filter(liveTask).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)),pending=current.filter(t=>t.pendingApproval);
  const recent=all.filter(t=>!liveTask(t)).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,5),mainRows=current.length?current.slice(0,5):recent;
  return pageHead('工作总览','把正在发生的事放在最前面：中间看任务，右边处理需要你决定的请求。没有当前任务时显示最近 5 条记录。')+
  `<div class="health-line"><div><div class="title ${h.healthy===true?'good-text':h.healthy===false?'bad-text':''}"><span class="dot ${h.healthy===true?'good':h.healthy===false?'bad':''}"></span>${h.healthy===true?'Bridge 正常':h.healthy===false?'Bridge 不可达':'Bridge 状态未知'}</div><div class="detail">127.0.0.1:7690 · ${e(h.version||'版本未提供')}</div></div><div class="split"><div>${(state.channels||[]).filter(c=>c.connected===true).length} / ${(state.channels||[]).length||'未知'} 条 Bridge 通道正常</div><div class="detail">Bridge A / B 独立连接</div></div></div>
  <div class="overview-work"><div class="overview-main"><section class="section"><div class="section-head"><div><h2>当前任务</h2><p>${current.length?'实时显示正在运行、等待处理和状态未知的任务。':'当前没有运行任务，下面显示最近完成或停止的 5 条记录。'}</p></div><button class="text-button" data-nav="tasks">查看全部任务</button></div><div class="counts-inline"><span><b>${number(counts?.active)}</b>运行中</span><span><b>${number(counts?.awaitingApproval)}</b>需要处理</span><span><b>${number(counts?.uncertain)}</b>状态未知</span></div>${taskTable(mainRows,true)}</section>
  <section class="section"><div class="section-head"><h2>Bridge A / B</h2><button class="text-button" data-nav="channels">管理连接</button></div><div class="rows">${channelRows()}</div></section></div>
  <aside class="overview-pending"><div class="section-head"><div><h2>需要你处理</h2><p>只列需要人工决定的当前请求。</p></div><span class="pill ${pending.length?'warn':'good'}">${pending.length}</span></div>${pending.length?`<div class="request-list">${pending.slice(0,5).map(t=>`<div class="request-row" data-key="request-${e(t.provider+':'+t.ref)}"><div><strong>${e(requestExplanation(t).title)}</strong><p class="muted clamp">${e(t.title||'未命名任务')}</p><small>${e(names[t.provider]||t.provider)} · ${e(statusNames[t.status]||t.status)}</small></div><button class="primary" data-task="${e(t.ref)}" data-provider="${e(t.provider)}">处理</button></div>`).join('')}</div>`:'<div class="quiet-empty">目前没有需要你处理的请求。</div>'}<button class="text-button" data-nav="tasks">进入任务中心</button></aside></div>
  <section class="section overview-settings"><div class="section-head"><div><h2>当前设置与生效情况</h2><p>低频信息放在这里，需要时再看。</p></div><button class="text-button" data-nav="concurrency">调整设置</button></div>${settingsStatus()}<div class="overview-settings-grid"><div><span>全部任务限制</span><strong>${state.settings.value.admission.maxActive||'不设额外上限'}</strong></div><div><span>当前占用</span><strong>${number(counts?.counted)}</strong></div><div><span>接收新任务</span><strong>${state.settings.value.admission.paused?'已暂停':'开启'}</strong></div><div><span>Memory</span><strong>${r?.memory?.enabled?'开启':'未确认'}</strong></div></div></section>${operationBox()}${controlNotice()}${alertsBox()}`;
}

function tasks(){return pageHead('任务','当前任务、需要处理和历史记录都在这里。状态、Token 和操作来自同一条任务记录，不再拆成重复页面。')+controlNotice()+`<div class="task-summary"><span><b>${number(state.runtime?.counts?.active)}</b> 运行中</span><span><b>${number(state.runtime?.counts?.awaitingApproval)}</b> 需要处理</span><span><b>${number((state.tasks||[]).filter(t=>!t.live).length)}</b> 历史记录</span></div><div class="filter-row"><input id="task-search" type="search" placeholder="搜索任务、项目、模型或编号" value="${e(taskSearch)}" aria-label="搜索任务"><select id="task-provider" aria-label="筛选 Agent"><option value="">全部 Agent</option>${Object.entries(names).map(([v,n])=>`<option value="${v}" ${filterProvider===v?'selected':''}>${n}</option>`).join('')}</select><select id="task-status" aria-label="筛选任务状态">${[['live','当前任务'],['awaitingApproval','需要处理'],['completed','已完成'],['failed','失败'],['interrupted','已停止'],['unknown','状态未知'],['unverified','旧记录'],['all','全部记录']].map(([v,n])=>`<option value="${v}" ${filterStatus===v?'selected':''}>${n}</option>`).join('')}</select></div><div id="task-list">${taskTable(filteredTasks())}</div><p class="footer-note">页面操作会在提交前重新核验任务、轮次和请求。旧记录可以删除；底层审计和 Token 统计仍保留。</p>`;}

function filteredTasks(){return (state.tasks||[]).filter(t=>(!filterProvider||t.provider===filterProvider)&&(filterStatus==='all'||(filterStatus==='live'?liveTask(t):filterStatus==='completed'?['completed','idle'].includes(t.status):t.status===filterStatus))&&(!taskSearch||[t.title,t.cwd,t.project,t.model,t.ref,t.requestId].join(' ').toLowerCase().includes(taskSearch.toLowerCase())));}

function modelChoices(provider,value=''){
  const rows=[],seen=new Set(),add=(id,name=id,efforts=[])=>{if(!id||seen.has(id))return;seen.add(id);rows.push({id,name:name||id,efforts:Array.isArray(efforts)?efforts:[]});};
  const pools=provider?[modelCatalog[provider]]:Object.values(modelCatalog);
  for(const pool of pools)if(Array.isArray(pool))for(const m of pool)add(m.id,m.name,m.efforts);
  for(const t of state?.tasks||[])if((!provider||t.provider===provider)&&t.model)add(t.model,t.model,[]);
  for(const id of usageModels)add(id,id,[]);if(value)add(value,value,[]);
  return rows.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
}
function numericChoices(f,value){const values=[];for(let n=f.min;n<=f.max;n++)values.push(n);if(Number.isFinite(Number(value))&&!values.includes(Number(value)))values.push(Number(value));return values.sort((a,b)=>a-b);}
function field(f,value,prefix='setting'){
  const id=prefix+'-'+f.key.replace(/[^a-z0-9]/gi,'-'),type=f.type||'number',provider=f.key.match(/^providers\.([^.]+)\./)?.[1]||null;let control,extra='';
  if(type==='boolean')control=`<input id="${id}" data-${prefix}="${e(f.key)}" type="checkbox" ${value?'checked':''} aria-describedby="${id}-help">`;
  else if(type==='select')control=`<select id="${id}" data-${prefix}="${e(f.key)}">${f.options.map(([v,n])=>`<option value="${v}" ${v===value?'selected':''}>${n}</option>`).join('')}</select>`;
  else if(type==='number'&&(/(^admission\.(maxActive|maxPerProject|focusLimit)$)|(^commands\.maxConcurrent$)|(^providers\..+\.maxActive$)/.test(f.key))){const opts=numericChoices(f,value);control=`<select id="${id}" data-${prefix}="${e(f.key)}">${opts.map(v=>`<option value="${v}" ${Number(value)===v?'selected':''}>${v===0?'0 · 不额外限制':v}</option>`).join('')}</select>`;extra=`当前 ${value} · 可选 ${f.min}–${f.max}`;}
  else if(type==='model'){const choices=modelChoices(provider,value);control=`<select id="${id}" data-${prefix}="${e(f.key)}"><option value="" ${!value?'selected':''}>不指定 · 由调用方决定</option>${choices.map(m=>`<option value="${e(m.id)}" ${m.id===value?'selected':''}>${e(m.name)}${m.name!==m.id?' · '+e(m.id):''}</option>`).join('')}</select>`;extra=choices.length?'模型列表来自当前 catalog 与近期实际任务':'点击“读取可用模型”后显示执行器公开的模型';}
  else if(type==='effort'){const selectedModel=provider?getAt(draft,`providers.${provider}.defaultModel`):'',model=modelChoices(provider,selectedModel).find(m=>m.id===selectedModel),efforts=[...new Set(model?.efforts||[])];if(value&&!efforts.includes(value))efforts.push(value);control=`<select id="${id}" data-${prefix}="${e(f.key)}"><option value="" ${!value?'selected':''}>不指定 · 使用模型默认</option>${efforts.map(v=>`<option value="${e(v)}" ${v===value?'selected':''}>${e(v)}</option>`).join('')}</select>`;extra=selectedModel?(efforts.length?'仅显示 '+selectedModel+' 公布的档位':'当前 catalog 未公布该模型的推理档位'):'先选择默认模型，再选择推理强度';}
  else control=`<input id="${id}" data-${prefix}="${e(f.key)}" type="${type==='number'?'number':'text'}" value="${e(value)}" ${type==='number'?`min="${f.min}" max="${f.max}" step="1"`:''} aria-describedby="${id}-help" ${type!=='number'?'maxlength="512"':''}>`;
  const help=[f.help||'',extra].filter(Boolean).join(' · ');return `<div class="setting-row"><div><label for="${id}">${e(f.label)}${f.effect?`<span class="effect">${e(f.effect)}</span>`:''}</label><div class="help" id="${id}-help">${e(help)}</div></div><div class="control">${control}</div></div>`;
}
function saveBar(){return `<div class="save-bar"><small id="save-note">${e(settingsConflict?'另一个窗口已保存新版本，当前草稿仍保留。':dirty?'有尚未保存的更改':saveFeedback||'填写后保存，无需再次确认。')}</small><div class="actions"><button id="reset-settings" ${dirty?'':'disabled'}>撤销更改</button><button class="primary" id="save-settings" ${dirty?'':'disabled'}>保存更改</button></div></div>`;}

function settingsPage(){
  const section=sectionFor[view],title=views.find(v=>v[0]===view)?.[1]||section,desc={concurrency:'控制同时执行的数量。降低上限不停止已有任务，超限直接拒绝，没有后台排队。',providers:'分别控制 Agent 并发，以及新任务默认模型和推理强度。明确指定的模型仍优先。',channels:'Bridge A / B 独立控制。Remote Proxy 只决定该通道如何连接远端控制平面，不给 Agent 提供通用上网代理。',memory:'查看真实长期 Memory，并管理自动清理与保护区。清理前可先预览实际范围。',recovery:'查看恢复策略与发布验证。手动维护会显示具体对象和影响，候选不会自动切换生产。',appearance:'调整此管理窗口的外观和读取频率。刷新不会消耗模型额度。'}[view];
  const fields=catalog.fields.filter(f=>f.section===section),draw=f=>field({...f,effect:/^立即/.test(f.effect||'')?'保存后待确认':f.effect},getAt(draft,f.key));
  let body=pageHead(title,desc,['providers','concurrency'].includes(view)?'<button id="load-models">刷新模型列表</button>':'');
  if(view==='channels')body+='<div class="rows">'+channelRows(true)+'</div><p class="footer-note">Bridge A / B 独立运行。停用一个通道不会关闭另一个；Remote Proxy 修改后只需重连对应通道。</p>';
  body+=settingsStatus();
  if(view==='recovery')body+=operationBox()+candidateBox()+`<section class="action-list"><div class="action-row"><div><h3>启动或恢复桥接</h3><p class="desc">使用当前稳定版本。健康服务由安全启动检查后保持运行。</p></div><button data-maintenance="ensure">启动或恢复</button></div></section><details class="section"><summary>维护操作：重启、候选发布与登录自启</summary><div class="action-list"><div class="action-row"><div><h3>重启稳定版本</h3><p class="desc">服务会短暂不可达，后台须先核验不存在活动或状态不明任务。</p></div><button data-maintenance="restart">重启稳定版本</button></div><div class="action-row"><div><h3>候选验证与发布</h3><p class="desc">验证不会切换生产；发布会切换已验证候选，活动任务未结束时不允许继续。</p></div><div class="buttons"><button data-maintenance="verify">验证候选</button><button data-maintenance="promote">发布已验证候选</button></div></div><div class="action-row"><div><h3>面板后台登录自启</h3><p class="desc">只管理面板后台的登录启动方式，关闭窗口不停止后台。</p></div><div class="buttons"><button data-maintenance="startupEnable">启用自启</button><button data-maintenance="startupDisable">关闭自启</button></div></div></div></details>`;
  if(view==='memory'){body+=operationBox();const m=state.runtime?.memory;body+=`<dl class="definition horizontal section"><div><dt>Memory 状态</dt><dd>${m?m.enabled?'正在使用':'已暂停':'未知，等待运行时'}</dd></div><div><dt>运行时记录数</dt><dd>${number(m?.items)}</dd></div><div><dt>存储位置</dt><dd class="mono break-word">${e(m?.dbPath||'未提供')}</dd></div><div><dt>隔离规则</dt><dd>按 Agent / 项目 / 工具分层；敏感信息写入前会脱敏。</dd></div></dl><div id="memory-panel">${memoryPanel()}</div>`;}
  body+='<section class="settings-section">';
  if(view==='providers'){
    for(const [key,name]of Object.entries(names)){const group=fields.filter(f=>f.key.startsWith('providers.'+key+'.')),liveProvider=state.runtime?.providers?.find?.(p=>p.id===key);if(group.length)body+='<section class="provider-settings"><div class="section-head"><div><h2>'+e(name)+'</h2><p>当前占用 '+number(liveProvider?.active)+' · '+(liveProvider?.available===false?'当前不可用':'运行状态由 Bridge 实时核验')+'</p></div></div>'+group.map(draw).join('')+'</section>';}
  }else if(view==='concurrency'){
    body+=fields.filter(f=>['admission.paused','admission.maxActive','admission.maxPerProject','admission.focusModel','admission.focusLimit'].includes(f.key)).map(draw).join('')+'<details class="section"><summary>其他规则：审批计数与本地命令</summary>'+fields.filter(f=>!['admission.paused','admission.maxActive','admission.maxPerProject','admission.focusModel','admission.focusLimit'].includes(f.key)).map(draw).join('')+'</details><p class="footer-note">并发限制只决定新任务能否开始，不会取消已经运行的任务；页面会显示当前值和允许范围。</p>';
  }else if(view==='recovery'){
    body+=fields.filter(f=>f.key==='recovery.enabled').map(draw).join('')+'<details class="section"><summary>高级恢复间隔与阈值</summary>'+fields.filter(f=>f.key!=='recovery.enabled').map(draw).join('')+'</details>';
  }else body+=fields.map(draw).join('');
  body+='<datalist id="model-list"></datalist></section>'+saveBar();
  if(view==='memory')body+=`<section class="settings-section section"><div class="section-head"><h2>自动清理</h2><button id="load-housekeeping">重新读取</button></div><div id="housekeeping-form">${houseDoc?houseForm():'<p class="muted">正在读取清理配置…</p>'}</div></section>`;
  return body;
}

function houseForm(){const protectedPaths=houseDoc.value.protectedPaths||[];return catalog.housekeeping.map(f=>field({...f,effect:'下一轮清理'},houseDoc.value[f.key],'house')).join('')+`<section class="protected-paths"><div class="section-head"><div><h3>保护区</h3><p>这些文件或文件夹不会被自动清理。只能填写 Spike Bridge 项目目录内的路径。</p></div><span class="pill">${protectedPaths.length}</span></div>${protectedPaths.length?`<div class="protected-list">${protectedPaths.map((p,i)=>`<div class="protected-row"><code>${e(p)}</code><button class="danger" data-protected-remove="${i}">移除</button></div>`).join('')}</div>`:'<div class="quiet-empty">还没有额外保护路径。</div>'}<div class="protected-add"><input id="protected-new" maxlength="2048" placeholder="例如：data\\important 或 C:\\Projects\\SpikeBridgeFixture\\tmp\\keep"><button id="protected-add">加入保护区</button></div></section><div class="save-bar"><small>${e(houseFeedback||'保存后等待运行时确认。立即清理会另行确认。')}</small><div class="actions"><button data-maintenance="housekeepingPreview">预览清理范围</button><button data-maintenance="housekeepingRun">立即清理</button><button class="primary" id="save-housekeeping">保存清理设置</button></div></div>`;}
const memoryScopeNames={global:'全局',machine:'本机',provider:'Agent',project:'项目',tool:'工具'};
const memoryStatusNames={active:'启用',candidate:'候选',superseded:'已替代',expired:'已过期',rejected:'已拒绝'};
function memoryPanel(){
  if(memoryLoading&&!memoryData)return '<section class="settings-section section"><h2>Memory 列表</h2><p class="muted">正在读取真实 Memory Core…</p></section>';
  const items=memoryData?.items||[],shown=items.filter(x=>memoryFilter==='all'||x.scope===memoryFilter),status=memoryData?.status||{};
  return `<section class="settings-section section"><div class="section-head"><div><h2>Memory 列表</h2><p>这里直接读取 Bridge 的 Experience Memory，不是另一套面板数据。</p></div><button id="load-memory">刷新 Memory</button></div><div class="memory-summary"><span><b>${number(status.items)}</b> 总记录</span><span><b>${number(status.core)}</b> Core</span><span><b>${number(status.evidence)}</b> Evidence</span></div><div class="memory-toolbar"><select id="memory-filter" aria-label="Memory 层级筛选"><option value="all">全部层级</option>${Object.entries(memoryScopeNames).map(([v,n])=>`<option value="${v}" ${memoryFilter===v?'selected':''}>${n}</option>`).join('')}</select><span class="muted">显示 ${shown.length} / ${items.length}</span></div>${shown.length?`<div class="memory-list">${shown.map(m=>`<article class="memory-row" data-key="${e(m.id)}"><div class="memory-row-head"><div><strong>${e(m.title||'未命名 Memory')}</strong><div class="memory-meta"><span class="pill">${e(memoryScopeNames[m.scope]||m.scope)}</span><span>${e(memoryStatusNames[m.status]||m.status||'未知')}</span><span>${e(m.confidence||'未标注')}</span></div></div><button class="danger" data-memory-delete="${e(m.id)}">删除</button></div><p>${e(m.summary||'没有摘要')}</p><dl class="memory-scope"><div><dt>Agent</dt><dd>${e(names[m.provider]||m.provider||'全部')}</dd></div><div><dt>项目</dt><dd class="break-word">${e(m.project||'全部')}</dd></div><div><dt>工具</dt><dd>${e(m.tool||'全部')}</dd></div><div><dt>更新</dt><dd>${e(when(m.updated_at||m.created_at))}</dd></div></dl>${Array.isArray(m.tags)&&m.tags.length?`<div class="memory-tags">${m.tags.map(x=>`<span>${e(x)}</span>`).join('')}</div>`:''}</article>`).join('')}</div>`:'<div class="quiet-empty">这个层级暂时没有 Memory。</div>'}</section><section class="settings-section section"><h2>新增 Memory</h2><p class="muted">这是显式长期记忆。只有你在这里确认添加，才会写入 Memory Core。</p><div class="memory-form"><label>标题<input id="memory-title" maxlength="500" placeholder="例如：发布前必须先检查活动任务"></label><label>内容<textarea id="memory-summary" maxlength="8000" rows="4" placeholder="写清楚希望 Bridge 长期记住的规则或事实"></textarea></label><label>层级<select id="memory-scope"><option value="machine">本机</option><option value="global">全局</option><option value="provider">Agent</option><option value="project">项目</option><option value="tool">工具</option></select></label><label>Agent<select id="memory-provider"><option value="">全部</option>${Object.entries(names).map(([v,n])=>`<option value="${v}">${e(n)}</option>`).join('')}</select></label><label>项目<input id="memory-project" maxlength="1024" placeholder="需要项目层级时填写目录或项目标识"></label><label>工具<input id="memory-tool" maxlength="512" placeholder="需要工具层级时填写工具名"></label><label>标签<input id="memory-tags" maxlength="1000" placeholder="可选，用逗号分隔"></label></div><button class="primary" id="memory-add">确认新增 Memory</button></section>`;
}
function profilePage(){return pageHead('自动化规则','逐条管理 Bridge 的长期规则。现有基础 Profile 保留，不需要一次编辑整份文本。')+'<div id="policy-explanation">'+policyExplanation()+'</div><div id="profile-form">'+(profileDoc&&rulesDoc?profileForm():'<p class="muted">正在读取现行调用规则…</p>')+'</div>';}

function profileForm(){const p=profileDoc.profile||profileDoc,rules=rulesDoc?.rules||[];return `<section class="settings-section"><div class="section-head"><div><h2>调用确认</h2><p>只控制“是否在开始正式 Codex 调用前再问一次”。任务执行中的权限请求仍单独处理。</p></div><button id="load-profile">刷新规则</button></div><label class="check-label"><input id="call-approval" type="checkbox" ${(profileDraft?.requireCallApproval??p.effective?.requireCallApproval)!==false?'checked':''}>正式 Codex 调用前需要确认</label><div class="rule-actions"><button class="primary" id="save-profile-approval">保存确认设置</button></div></section><section class="settings-section"><div class="section-head"><div><h2>Bridge 逐条规则</h2><p>新增、修改或删除一条，不会覆盖其他规则。</p></div><span class="pill">${rules.length} 条</span></div>${rules.length?`<div class="rule-list">${rules.map(r=>`<div class="rule-row" data-key="${e(r.id)}"><textarea data-rule-text="${e(r.id)}" maxlength="4000" rows="2">${e(r.text)}</textarea><div class="rule-actions"><button data-rule-update="${e(r.id)}">保存这条</button><button class="danger" data-rule-delete="${e(r.id)}">删除</button></div></div>`).join('')}</div>`:'<div class="quiet-empty">还没有通过 Bridge 面板新增的逐条规则。</div>'}<div class="rule-add"><textarea id="rule-new" maxlength="4000" rows="3" placeholder="例如：发布前先检查是否有 running 或 awaitingApproval 任务。"></textarea><button class="primary" id="rule-add">新增规则</button></div></section><details class="settings-section"><summary>基础 Profile（兼容规则，只读）</summary><p class="muted">这是原有长期规则。Bridge 面板不会在删改单条规则时改写这部分。</p><pre class="evidence">${e(rulesDoc?.baseInstruction||'没有基础 Profile 文本')}</pre></details>`;}
function logsPage(){return pageHead('日志与诊断','查看服务日志或导出脱敏诊断。日志原文保留技术标识，不会输出登录凭据。',`<button id="export-diagnostics" class="primary">导出诊断</button>`)+operationBox()+`<div class="log-tools"><select id="log-kind" aria-label="日志分类"><option value="bridge">桥接服务错误与事件</option><option value="output">桥接服务输出</option><option value="operator">控制台操作记录</option></select><button id="load-logs">读取最新日志</button></div><pre id="log-view" class="log-view">正在读取日志…</pre><p class="footer-note">诊断文件只包含健康状态、版本、连接结果和精简任务标识，不包含密钥、完整任务正文或调用规则正文。</p>`;}
function advanced(){const entries=[['生产版本',state.bridge.version||'未提供'],['生产服务进程',state.bridge.pid||'未提供'],['生产服务地址','http://127.0.0.1:7690/mcp'],['本机管理端口',state.panel.port],['当前稳定版本指纹',state.lkg.digest||'未提供'],['运行实例指纹',state.bridge.artifactDigest||'未提供'],['公开工具数量',state.bridge.toolCount??'未提供'],['管理设置版本',state.settings.value.revision],['运行时已应用版本',state.runtime?.settingsRevision??'待连接'],['系统已运行',duration(state.machine.uptimeSeconds*1000)],['面板后台进程',state.panel.pid],['数据目录',state.lkg.artifactPath?'由项目本地目录管理':'待核验']];return pageHead('高级信息','这些是当前运行事实。生产端口、工具契约和账号隔离属于程序边界，不作为可随意改写的普通设置。')+`<dl class="definition horizontal">${entries.map(([k,v])=>`<div><dt>${e(k)}</dt><dd class="mono">${e(v)}</dd></div>`).join('')}</dl><div class="callout"><strong>不在界面中暴露密钥</strong><p>账号认证与通道密钥继续使用已有本机凭据。控制台可以操作连接生命周期，但不会把密码或令牌作为文本设置显示。</p></div><h2>运行边界</h2><div class="action-list"><div class="action-row"><div><h3>生产由安全启动管理</h3><p class="desc">候选验证、稳定版本提升与回退沿用项目现行发布流程。</p></div><span class="pill">固定保护</span></div><div class="action-row"><div><h3>命令单项目写入保护</h3><p class="desc">同一受信项目最多一个命令写入者；不会因调整全局并发而取消。</p></div><span class="pill">固定保护</span></div><div class="action-row"><div><h3>任务状态来源</h3><p class="desc">实时状态来自当前运行实例；重启前的旧记录标记为历史待核验，不伪装为仍在执行。</p></div><span class="pill">固定保护</span></div></div>`;}
function searchPage(){const q=search.toLowerCase(),fields=catalog.fields.filter(f=>[f.label,f.help,f.section].join(' ').toLowerCase().includes(q));const taskRows=state.tasks.filter(t=>[t.title,t.model,t.cwd].join(' ').toLowerCase().includes(q)).slice(0,20);return pageHead('搜索结果',`“${search}” · 找到 ${fields.length} 项设置和 ${taskRows.length} 条任务记录`)+`<div class="search-results">${fields.map(f=>`<button class="result" data-nav="${Object.keys(sectionFor).find(k=>sectionFor[k]===f.section)||'overview'}"><strong>${e(f.label)}</strong><small>${e(f.section)} · ${e(f.help)}</small></button>`).join('')}</div><section class="section">${taskRows.length?taskTable(taskRows):!fields.length?'<div class="empty"><strong>没有找到匹配内容</strong>试试“并发”“通道”“清理”或任务关键词。</div>':''}</section>`;}
function applyTheme(){const theme=state?.settings.value.panel.theme||'light';document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme;}
function render(patch=false){
  if(!state||!catalog)return;
  const nav=navGroups.map((g,i)=>{const buttons=g.items.map(id=>`<button data-nav="${id}" ${id===view&&!search?'aria-current="page"':''}>${e(views.find(v=>v[0]===id)[1])}${id==='tasks'?'<span class="nav-count">'+(state.controlConnected?number((state.tasks||[]).filter(t=>t.live&&t.pendingApproval).length):'未知')+'</span>':''}</button>`).join('');return g.collapse?`<details data-key="nav-${i}" ${g.items.includes(view)?'open':''}><summary>${g.title}</summary>${buttons}</details>`:`<div class="nav-group" data-key="nav-${i}"><div class="nav-label">${g.title}</div>${buttons}</div>`;}).join('');
  patchHTML($('#nav'),nav);
  const group=navGroups.find(g=>g.items.includes(view));const groupNode=$('#nav [aria-current="page"]')?.closest('details');if(groupNode)groupNode.open=true;
  $('#breadcrumb').textContent=(group?.title||'本机工作站')+' / '+(search?'搜索结果':views.find(v=>v[0]===view)?.[1]);
  const body=search?searchPage():view==='overview'?overview():view==='tasks'?tasks():view==='usage'?usageShell():view==='profile'?profilePage():view==='logs'?logsPage():view==='advanced'?advanced():settingsPage();
  if(patch)patchHTML($('#main'),body);else $('#main').innerHTML=body;
  applyTheme();
}
async function navigate(id){
  if(!views.some(v=>v[0]===id))return;
  if(hasDirty()&&id!==view){
    if(!await confirmAction('放弃未保存的设置？','切换分类不会自动保存。取消可返回当前草稿。','放弃更改'))return;
    dirty=false;houseDirty=false;profileDirty=false;profileDraft=null;houseDoc=null;draft=structuredClone(settingsDoc.value);settingsConflict=false;
  }
  view=id;taskPage=0;$('#toast').hidden=true;if(window.innerWidth<980)setNavigation(false);
  search='';$('#search').value='';render();$('#main').scrollTop=0;$('#main').focus();
  if(view==='memory'){if(!houseDoc)void loadHouse();if(!memoryData)void loadMemory();}
  if(view==='profile'&&!profileDoc)void loadProfile();
  if(view==='logs')void loadLogs();
  if(view==='usage')void loadUsage(true);
}

function confirmAction(title,message,label='确认继续',task=null){
  return new Promise(resolve=>{
    const d=$('#confirm-dialog');if(d.open){resolve(false);return;}
    $('#confirm-content').innerHTML=`<div class="dialog-head"><h2 id="confirm-title">${e(title)}</h2></div><div class="dialog-body"><p class="pre-wrap">${e(message)}</p>${task?`<dl class="definition section"><div><dt>任务</dt><dd>${e(task.title||task.ref)}</dd></div><div><dt>轮次 / 请求</dt><dd class="mono">${e(task.turnId)} / ${e(task.pendingApproval?.requestId||'无')}</dd></div></dl><div id="confirm-identity-warning" class="banner warning" hidden></div>`:''}</div><div class="dialog-foot"><button id="confirm-no" autofocus>返回核对</button><button id="confirm-yes" class="primary">${e(label)}</button></div>`;
    let settled=false;const done=value=>{if(settled)return;settled=true;d.removeEventListener('cancel',cancel);d.removeEventListener('close',cancel);d.close();resolve(value);};
    const cancel=event=>{event?.preventDefault();if(event?.type==='close'&&d.open)return;done(false);};d.addEventListener('cancel',cancel);d.addEventListener('close',cancel);
    $('#confirm-no').onclick=()=>done(false);$('#confirm-yes').onclick=()=>done(true);d.showModal();
  });
}
function requestExplanation(task){
  const p=task.pendingApproval||{},d=p.details||{},kind=d.kind||p.method||'';
  const isCommand=kind==='command'||/commandExecution|execCommand|command.*approval/i.test(kind);
  const isFile=['file','fileChange'].includes(kind)||/fileChange|applyPatch/i.test(kind);
  const isPermissions=kind==='permissions'||/permissions/i.test(kind);
  const isForm=kind==='elicitation'||/elicitation/i.test(kind)||d.requiresContent;
  const action=isCommand?d.command??d.argv:isFile?d.paths??d.files??d.changes??d.patch:isPermissions?d.permissions:isForm?d.message??d.humanText:d.humanText??d.message;
  const scope=isCommand?d.cwd:isFile?d.paths??d.files??d.changes:isPermissions?d.permissions:isForm?{...(d.serverName?{serverName:d.serverName}:{}),...(d.url?{url:d.url}:{}),...(d.requestedFields?{requestedFields:d.requestedFields}:{})}:d.scope??d.target;
  const place=isCommand?(d.cwd||task.cwd||task.project):isFile?(task.cwd||task.project):null;
  return {
    title:isCommand?'需要你确认一条本机命令':isFile?'需要你确认文件修改':isPermissions?'需要你确认额外权限':isForm?(d.requiresContent?'需要你填写信息':'需要你确认工具请求'):'需要你核对一个未知请求',
    summary:isCommand?`这个任务准备${place?'在 '+place+' ':' '}运行一条本机命令。接受后命令才会继续执行。`:isFile?`这个任务准备修改${place?' '+place+' 中的':''}文件。接受后才会把这次修改交给执行器继续处理。`:isPermissions?'这个任务希望扩大当前轮次可访问的文件、网络或其他能力范围。接受只针对这一次明确请求。':isForm?(d.requiresContent?'任务现在缺少一些信息，需要你填写后才能继续。':'一个工具正在等待你的明确同意或拒绝，任务会在这里暂停。'):'当前请求类型无法自动翻译成可靠说明，建议先看原始证据再决定。',
    action:action==null?'请求未提供完整动作；请查看原始证据，勿仅凭任务摘要判断。':plain(action),
    scope:scope==null||plain(scope)==='{}'?'请求未给出精确目标范围；任务工作目录仅供背景参考。':plain(scope),
    reason:plain(d.reason??d.justification??p.reason??task.reason??'当前请求未说明原因。'),
    impact:isCommand?'命令可能读取或修改文件、访问网络或启动程序。实际影响取决于下面折叠的原始命令。':isFile?'可能新增、覆盖或删除列出的文件；原始修改范围保留在技术详情里。':isPermissions?'可能扩大文件或网络访问范围；只应在你理解这次用途时接受。':isForm?'你填写的信息会返回给发起请求的工具，后续动作由该工具继续执行。':'现有信息不足，影响未知。',
    recommendation:isForm?'确认你认识接收方和字段含义，只填写自己明确选择的值。':'先看“它想做什么”和“可能影响”。涉及删除、安装、发布或权限扩大时再展开技术详情；如果看不懂就先保留。',
    known:isCommand||isFile||isPermissions||isForm
  };
}
function approvalFields(task){
  const d=task.pendingApproval?.details;if(!d?.requiresContent)return '';
  const properties=d.requestedSchema?.properties||{},required=new Set([...(d.requestedSchema?.required||[]),...(d.requiredFields||[])]);
  return '<div class="approval-form"><h3>填写本次请求的信息</h3><p class="muted">不会自动采用默认答案。填写内容仅在你确认本次请求后提交。</p>'+Object.entries(properties).map(([key,f],i)=>{
    const id='elic-'+i,common=`id="${id}" data-elic="${e(key)}" aria-describedby="${id}-help"`;
    let control;if(Array.isArray(f.enum))control=`<select ${common}><option value="">请选择</option>${f.enum.map((v,n)=>`<option value="${n}">${e(plain(v))}</option>`).join('')}</select>`;
    else if(f.type==='boolean')control=`<select ${common}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>`;
    else if(['object','array'].includes(f.type))control=`<textarea ${common} rows="3" placeholder="${f.type==='array'?'以 JSON 数组填写，例如 [1, 2]':'以 JSON 对象填写'}"></textarea>`;
    else control=`<input ${common} type="${['number','integer'].includes(f.type)?'number':'text'}" ${['number','integer'].includes(f.type)?'step="'+(f.type==='integer'?'1':'any')+'"':''} maxlength="${Number.isInteger(f.maxLength)?Math.min(f.maxLength,40000):40000}">`;
    return `<label for="${id}">${e(f.title||key)}${required.has(key)?'（必填）':''}</label>${control}<small id="${id}-help" class="muted">${e(f.description||'请按请求提供的字段含义填写。')}</small>`;
  }).join('')+'</div>';
}
function requestPanel(task){
  const x=requestExplanation(task);return `<section class="request-explanation"><div class="section-head"><div><h3>${e(x.title)}</h3><p>先看解释，技术原文放在最下面。</p></div><span class="pill warn">需要你决定</span></div><div class="request-summary"><strong>它想做什么</strong><p>${e(x.summary)}</p></div><dl class="definition"><div><dt>为什么现在停在这里</dt><dd class="pre-wrap">${e(x.reason)}</dd></div><div><dt>可能影响</dt><dd>${e(x.impact)}</dd></div><div><dt>建议怎么判断</dt><dd>${e(x.recommendation)}</dd></div></dl><details><summary>查看技术详情：原始动作、范围和请求数据</summary><dl class="definition"><div><dt>原始动作</dt><dd><pre class="evidence">${e(x.action)}</pre></dd></div><div><dt>原始范围</dt><dd><pre class="evidence">${e(x.scope)}</pre></dd></div></dl><pre class="evidence">${e(JSON.stringify(task.pendingApproval,null,2))}</pre></details>${approvalFields(task)}</section>`;
}
function showTask(provider,ref){
  const task=state.tasks.find(t=>t.provider===provider&&t.ref===ref);if(!task)return;
  activeTask=structuredClone(task);taskInvalid=false;taskFormDirty=false;dialogMode='task';returnFocus=document.activeElement;
  const d=$('#dialog');$('#dialog-content').innerHTML=`<div class="dialog-head"><div><div class="eyebrow">${e(names[task.provider]||task.provider)} · ${task.live?'当前实例':'历史记录'}</div><h2 id="dialog-title">任务详情 <span id="dialog-task-status">${pill(task.status)}</span></h2></div><button data-dialog-close>关闭</button></div><div class="dialog-body"><div id="task-changed" class="banner warning" role="status" hidden></div><h3>${e(task.title||'未命名任务')}</h3><p class="footer-note">此窗口绑定打开时的轮次与请求，刷新只更新状态、结果和用量。</p>${task.pendingApproval?requestPanel(task):''}<section class="section"><h3>实时进展</h3><div id="task-live-detail">${taskLiveDetail(task)}</div></section><details ${task.pendingApproval?'':'open'}><summary>任务背景与来源</summary><div class="description">${e(task.description||task.title)}</div>${task.descriptionIncomplete?'<p class="footer-note">旧记录只保留了摘要，因此可能缺少最初对话里的完整上下文。</p>':''}<dl class="definition horizontal section"><div><dt>Agent / 模型</dt><dd>${e(names[task.provider]||task.provider||'未提供')} · ${e(task.model||'未提供')}</dd></div><div><dt>推理强度</dt><dd>${e(task.effort||'未提供')}</dd></div><div><dt>项目</dt><dd class="break-word">${e(task.cwd||task.project||'未提供')}</dd></div><div><dt>为什么启动</dt><dd class="pre-wrap">${e(task.reason||'当前任务没有保存额外的调用原因。')}</dd></div><div><dt>来源</dt><dd>${e(task.source||'Bridge 任务记录')}</dd></div><div><dt>开始时间</dt><dd>${e(when(task.startedAt))}</dd></div></dl><details><summary>技术编号（排查问题时再看）</summary><dl class="definition"><div><dt>Agent ID</dt><dd class="mono break-word">${e(task.ref)}</dd></div><div><dt>Turn ID</dt><dd class="mono break-word">${e(task.turnId||'未知')}</dd></div><div><dt>启动 Request ID</dt><dd class="mono break-word">${e(task.requestId||'未提供')}</dd></div><div><dt>当前 Approval ID</dt><dd class="mono break-word">${e(task.pendingApproval?.requestId||'无')}</dd></div></dl><p class="footer-note">Bridge 当前不保存 ChatGPT 会话 URL，因此不会伪造对话链接；这里展示的是实际保存的任务来源与请求标识。</p></details></details>${!task.live?'<p class="footer-note">历史记录不属于当前运行实例，控制操作已禁用。可以从任务列表删除；底层审计与用量记录仍保留。</p>':''}</div><div class="dialog-foot">${task.pendingApproval?'<button id="task-reject" class="danger">拒绝</button><button id="task-approve" class="primary">接受</button>':''}${(!task.live||['completed','idle','failed','interrupted','rejected','lost'].includes(task.status))?'<button id="task-dismiss-history" class="danger">删除这条记录</button>':''}<button id="task-cancel" class="danger">停止本轮任务</button><button data-dialog-close>关闭</button></div>`;
  if(!d.open)d.showModal();syncTaskDialog();
}
function taskLiveDetail(t){
  const u=t.usage||t.quota?.usage;
  return `<p class="muted">更新于 ${e(when(t.updatedAt))} · ${e(t.endedAt?'已结束于 '+when(t.endedAt):'尚未提供结束时间')}</p><div class="description live-result">${e(plain(t.result??t.progress??t.error??'尚无新的进展正文，等待执行器提供。'))}</div><dl class="definition horizontal section"><div><dt>已记录Token总数</dt><dd>${number(u?.totalTokens)}</dd></div><div><dt>输入 / 输出</dt><dd>${number(u?.inputTokens)} / ${number(u?.outputTokens)}</dd></div></dl><p class="footer-note">缓存是输入的一部分，推理是输出的一部分。未提供用量时显示未知；不会据此推算余额或费用。</p>`;
}
function syncTaskDialog(){
  if(dialogMode!=='task'||!activeTask||!$('#dialog').open)return;
  const t=state?.tasks?.find(x=>x.ref===activeTask.ref&&x.provider===activeTask.provider);
  if(!t||taskIdentity(t)!==taskIdentity(activeTask)||!t.live)taskInvalid=true;
  if(t){patchHTML($('#dialog-task-status'),pill(t.status));patchHTML($('#task-live-detail'),taskLiveDetail(t));}
  const blocked=taskInvalid||!stateFresh||authExpired;
  const reason=taskInvalid?'轮次、请求内容或控制归属已变化。已保留你的表单；旧操作已锁定，请重新核对最新请求。':authExpired?'窗口认证已过期，操作已锁定。请从桌面重新打开。':!stateFresh?'当前数据已过期或后台不可达，暂不能提交操作。连接恢复后会重新核验。':'';
  const warning=$('#task-changed');if(warning){warning.hidden=!reason;patchHTML(warning,e(reason)+(taskInvalid?'<p><button id="task-reopen">重新核对最新任务</button></p>':''));}
  for(const action of ['approve','reject','cancel']){
    const btn=$('#task-'+action);if(!btn)continue;
    btn.disabled=blocked||taskBusy||!t?.live||!t?.turnId||t.status==='unknown'||(action!=='cancel'&&(!t.pendingApproval?.requestId||!activeTask.pendingApproval?.requestId))||(action==='cancel'&&!['starting','running','awaitingApproval'].includes(t?.status));
  }
  if($('#confirm-identity-warning')){$('#confirm-identity-warning').hidden=!reason;$('#confirm-identity-warning').textContent=reason;$('#confirm-yes').disabled=blocked;}
}
function validateAnswer(value,schema,path){
  if(schema.enum&&!schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))throw new Error(path+'：请选择请求中列出的值。');
  const type=schema.type;
  if(type==='integer'&&!Number.isInteger(value)||type==='number'&&!Number.isFinite(value)||type==='boolean'&&typeof value!=='boolean'||type==='string'&&typeof value!=='string'||type==='array'&&!Array.isArray(value)||type==='object'&&(!value||Array.isArray(value)||typeof value!=='object'))throw new Error(path+'：值的类型不符合请求。');
  if(typeof value==='number'&&(schema.minimum!=null&&value<schema.minimum||schema.maximum!=null&&value>schema.maximum))throw new Error(path+'：数值超出允许范围。');
  if(typeof value==='string'&&(schema.minLength!=null&&value.length<schema.minLength||schema.maxLength!=null&&value.length>schema.maxLength))throw new Error(path+'：文字长度不符合请求。');
  if(Array.isArray(value)){if(schema.minItems!=null&&value.length<schema.minItems||schema.maxItems!=null&&value.length>schema.maxItems)throw new Error(path+'：条目数量不符合请求。');if(schema.items)for(const x of value)validateAnswer(x,schema.items,path);}
  if(value&&typeof value==='object'&&!Array.isArray(value)){for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw new Error(path+'：缺少字段 '+k);for(const [k,v]of Object.entries(value)){if(schema.properties?.[k])validateAnswer(v,schema.properties[k],path+'.'+k);else if(schema.additionalProperties===false)throw new Error(path+'：包含未允许字段 '+k);}}
}
function collectAnswers(task){
  const d=task.pendingApproval?.details;if(!d?.requiresContent)return undefined;
  const schema=d.requestedSchema;if(!schema?.properties)throw new Error('当前请求未提供可填写的结构，请保留待处理并核对原始请求。');
  const required=new Set([...(schema.required||[]),...(d.requiredFields||[])]),content=Object.create(null);
  for(const input of document.querySelectorAll('[data-elic]')){
    const key=input.dataset.elic,f=schema.properties[key],raw=input.value;
    try{
      if(raw===''){if(required.has(key))throw new Error((f.title||key)+'为必填项。');continue;}
      const value=Array.isArray(f.enum)?f.enum[Number(raw)]:f.type==='boolean'?raw==='true':['integer','number'].includes(f.type)?Number(raw):['object','array'].includes(f.type)?JSON.parse(raw):raw;
      validateAnswer(value,f,f.title||key);content[key]=value;
    }catch(err){input.focus();throw new Error(err instanceof SyntaxError?(f.title||key)+'需要有效 JSON。':err.message);}
  }
  return content;
}
async function actTask(action){
  if(taskBusy||taskInvalid||!activeTask||!stateFresh)return;
  const task=structuredClone(activeTask);let content;
  try{if(action==='approve')content=collectAnswers(task);}catch(err){toast(err.message,true);return;}
  const x=requestExplanation(task),message=action==='cancel'?'中断所选轮次。已经产生的文件或外部操作不会被撤销。':(action==='approve'?'只提交对下列这一个请求的同意。':'只拒绝下列这一项请求。')+'\n\n具体动作：\n'+x.action+'\n\n目标与范围：\n'+x.scope+(content?'\n\n将提交的信息：\n'+JSON.stringify(content,null,2):'');
  taskBusy=true;syncTaskDialog();
  try{
    const confirmed=await confirmAction({approve:'批准本次请求？',reject:'拒绝本次请求？',cancel:'停止本轮任务？'}[action],message,{approve:'确认批准本次请求',reject:'确认拒绝',cancel:'确认停止本轮'}[action],task);
    if(!confirmed)return;
    toast('正在核验轮次与请求是否仍然一致…');
    if(!await refresh(true)||taskInvalid||taskIdentity(activeTask)!==taskIdentity(task))throw new Error('状态未通过核验。未提交操作，请重新检查当前请求。');
    const current=state.tasks.find(t=>t.provider===task.provider&&t.ref===task.ref);
    if(taskIdentity(current)!==taskIdentity(task)||!current?.live||!current.turnId)throw new Error('当前请求已变化，未提交操作。');
    await post('task',{provider:task.provider,ref:task.ref,action,requestId:crypto.randomUUID(),expectedTurnId:task.turnId,approvalRequestId:task.pendingApproval?.requestId,elicitationContent:content,confirmed:true,decisionSource:'operator'});
    taskInvalid=true;taskFormDirty=false;toast('已收到操作回执，正在读取实际状态。');await refresh(true);
  }catch(err){taskInvalid=true;toast(err.message,true);}
  finally{taskBusy=false;syncTaskDialog();}
}

async function quickTaskAction(action,provider,ref){
  showTask(provider,ref);
  if(!activeTask)return;
  if(action==='dismiss')return dismissTaskHistoryRecord();
  return actTask(action);
}

async function dismissTaskHistoryRecord(){
  if(taskBusy||!activeTask||!stateFresh)return;
  const task=structuredClone(activeTask),terminal=['completed','idle','failed','interrupted','rejected','lost'].includes(task.status);
  if(task.live&&!terminal){toast('当前运行、待处理或状态不明的任务不能删除。',true);return;}
  const confirmed=await confirmAction('删除这条任务记录？','只从 Operator 任务列表移除这条已结束或旧版本记录，以及同一任务更老的历史版本。不会删除项目文件、Token 用量或底层 Agent 审计；同一 Agent 未来产生更新轮次时仍会重新出现。','确认删除记录',task);
  if(!confirmed)return;
  taskBusy=true;
  try{
    if(!await refresh(true))throw new Error('当前状态无法重新核验，未删除记录。');
    const expectedStamp=taskStamp(task.updatedAt);
    const current=state.tasks.find(t=>t.provider===task.provider&&t.ref===task.ref&&taskStamp(t.updatedAt)===expectedStamp);
    if(!current)throw new Error('这条任务已经变化、已删除或不再可见，请刷新后重新核对。');
    if(current.live&&!['completed','idle','failed','interrupted','rejected','lost'].includes(current.status))throw new Error('任务状态已经变化，当前不能删除。');
    await post('task-history',{action:'dismiss',provider:task.provider,ref:task.ref,updatedAt:task.updatedAt,confirmed:true});
    $('#dialog').close();activeTask=null;dialogMode='';taskFormDirty=false;taskInvalid=false;
    toast('已从任务列表删除这条历史记录。底层审计与用量仍保留。');await refresh(true);
  }catch(err){toast(err.message,true);}
  finally{taskBusy=false;syncTaskDialog();}
}

async function maintenance(action,lane){
  const laneName=lane==='a'?'Bridge A':lane==='b'?'Bridge B':'未指定通道';
  const digest=state?.candidateVerification?.receipt?.digest;
  const descriptions={
    ensure:['启动或恢复桥接？','对象：本机桥接稳定版本。安全启动将检查当前服务，必要时启动恢复。'],
    verify:['验证管理候选？','对象：后台准备的候选版本。将运行验证并记录结果，验证本身不切换生产。'],
    promote:['发布已验证候选？','对象：本机生产桥接。将切换下列已验证候选；后台仍需核验没有活动或状态不明任务。\n候选指纹：'+(digest||'尚未提供')],
    restart:['重启当前稳定版本？','对象：本机生产桥接。服务会短暂不可达；后台须先确认没有活动或状态不明任务。'],
    channelStart:['启动'+laneName+'？','对象：'+laneName+'。将启用该通道守护任务并建立连接。'],
    channelStop:['停用'+laneName+'？','对象：'+laneName+'。将关闭该通道的计划任务与进程，经由该通道的网页连接会中断。'],
    channelRestart:['重新连接'+laneName+'？','对象：'+laneName+'。该通道会短暂断开，并使用已保存的代理重新连接。'],
    startupEnable:['启用面板登录自启？','对象：本机面板后台。登录后会启动面板后台服务。'],
    startupDisable:['关闭面板登录自启？','对象：本机面板后台。后续登录不再自动启动此后台。'],
    housekeepingRun:['执行清理？','对象：保守清理规则允许的临时文件、过期日志与隔离区。依规则移入隔离区或清除过期隔离内容；请先预览范围。']
  };
  if(!stateFresh||authExpired){toast('请先刷新核验当前状态，再进行维护操作。',true);return;}
  if(action==='promote'&&!digest){toast('尚无可核对的已验证候选指纹。',true);return;}
  if(descriptions[action]&&!await confirmAction(...descriptions[action]))return;
  if(!await refresh(true)||!stateFresh){toast('当前状态无法重新核验，未提交维护操作。',true);return;}
  if(action==='promote'&&digest!==state?.candidateVerification?.receipt?.digest){toast('候选指纹已变化，请重新核对。',true);return;}
  const buttons=[...document.querySelectorAll('[data-maintenance]')];buttons.forEach(b=>b.disabled=true);
  try{
    await post('action',{action,lane,confirmed:true,requestId:crypto.randomUUID(),...(action==='promote'?{expectedDigest:digest}:{})});
    toast('操作已提交，结果以后台回执为准。');await refresh(true);
    if(!['overview','recovery','logs'].includes(view)&&action!=='housekeepingPreview')await navigate('overview');
  }catch(err){toast(err.message,true);}
  finally{buttons.forEach(b=>{if(b.isConnected)b.disabled=false;});}
}

async function loadHouse(){
  if(houseLoading)return;
  if(houseDirty&&!await confirmAction('重新读取清理设置？','尚未保存的清理修改会被丢弃。','重新读取'))return;
  const version=houseEditVersion;houseLoading=true;
  try{const data=await api('housekeeping');if(version!==houseEditVersion){toast('读取期间你编辑了清理设置，已保留草稿。');return;}houseDoc=data;houseDirty=false;if(view==='memory')patchHTML($('#housekeeping-form'),houseForm());}
  catch(err){if(!houseDoc&&$('#housekeeping-form'))$('#housekeeping-form').innerHTML='<p class="warning-text">'+e(err.message)+'</p>';else toast(err.message,true);}
  finally{houseLoading=false;}
}
async function loadProfile(){
  if(profileLoading)return;
  if(profileDirty&&!await confirmAction('重新读取自动化规则？','尚未保存的调用确认设置会被丢弃。','重新读取'))return;
  const version=profileEditVersion;profileLoading=true;
  try{const [profile,rules]=await Promise.all([api('profile'),api('rules')]);if(version!==profileEditVersion){toast('读取期间你编辑了确认设置，已保留草稿。');return;}profileDoc=profile;rulesDoc=rules;profileDirty=false;profileDraft=null;if(view==='profile')patchHTML($('#profile-form'),profileForm());}
  catch(err){if(!profileDoc&&$('#profile-form'))$('#profile-form').innerHTML='<p class="warning-text">'+e(err.message)+'</p>';else toast(err.message,true);}
  finally{profileLoading=false;}
}
async function mutateRule(action,id=null,text=null){
  const messages={add:'新增这条自动化规则？',update:'保存这条自动化规则？',delete:'删除这条自动化规则？'};
  if(['add','update'].includes(action)&&(!text||!text.trim())){toast('规则内容不能为空。',true);return;}
  if(!await confirmAction(messages[action]||'修改自动化规则？','只修改这一条 Bridge 规则；现有基础 Profile 和其他逐条规则保持不变。','确认修改'))return;
  await post('rules',{action,id,text:text?.trim(),confirmed:true});toast('自动化规则已更新。');await loadProfile();
}
async function loadMemory(){
  if(memoryLoading)return;memoryLoading=true;if(view==='memory'&&$('#memory-panel')&&!memoryData)patchHTML($('#memory-panel'),memoryPanel());
  try{memoryData=await api('memory?limit=500');if(view==='memory'&&$('#memory-panel'))patchHTML($('#memory-panel'),memoryPanel());}
  catch(err){toast(err.message,true);if(view==='memory'&&$('#memory-panel')&&!memoryData)$('#memory-panel').innerHTML='<p class="warning-text">'+e(err.message)+'</p>';}
  finally{memoryLoading=false;}
}
async function addMemory(){
  const title=$('#memory-title')?.value.trim(),summary=$('#memory-summary')?.value.trim(),scope=$('#memory-scope')?.value,provider=$('#memory-provider')?.value||null,project=$('#memory-project')?.value.trim()||null,tool=$('#memory-tool')?.value.trim()||null,tags=($('#memory-tags')?.value||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!title||!summary){toast('请填写 Memory 标题和内容。',true);return;}
  if(scope==='provider'&&!provider||scope==='project'&&!project||scope==='tool'&&!tool){toast('所选 Memory 层级还缺少对应范围。',true);return;}
  if(!await confirmAction('新增这条 Memory？','这会把你明确填写的内容写入 Bridge 的长期 Memory Core。后续相关任务可能会读取它。','确认新增'))return;
  await post('memory',{action:'add',title,summary,scope,provider,project,tool,tags,confirmed:true});toast('Memory 已新增。');await loadMemory();
}
async function deleteMemory(id){
  const item=memoryData?.items?.find(x=>x.id===id);if(!item)return;
  if(!await confirmAction('删除这条 Memory？','删除后 Bridge 不再把它作为长期经验使用。与它相关的任务文件不会被删除。\n\n'+(item.title||id),'确认删除'))return;
  await post('memory',{action:'delete',id,confirmed:true});toast('Memory 已删除。');await loadMemory();
}
async function loadLogs(){
  const seq=++logSequence,kind=$('#log-kind')?.value||'bridge';
  if($('#log-view'))$('#log-view').textContent='正在读取日志…';
  try{const data=await api('logs?kind='+encodeURIComponent(kind));if(seq===logSequence&&$('#log-view'))$('#log-view').textContent=data.text||'暂无日志。';}
  catch(err){if(seq===logSequence&&$('#log-view'))$('#log-view').textContent=err.message;}
}
async function saveSettings(){
  if(!dirty)return;
  const inputs=[...document.querySelectorAll('[data-setting]')];for(const input of inputs)if(!input.reportValidity())return;
  const savedDraft=structuredClone(draft),expected=settingsDoc.hash,changed=catalog.fields.filter(f=>getAt(savedDraft,f.key)!==getAt(settingsDoc.value,f.key));
  const button=$('#save-settings');button.disabled=true;button.textContent='正在保存…';
  try{
    const result=await post('settings',{value:savedDraft,expectedHash:expected});
    const editedDuringSave=JSON.stringify(draft)!==JSON.stringify(savedDraft);
    settingsDoc=result;state.settings=result;settingsConflict=false;
    if(editedDuringSave){draft.revision=result.value.revision;dirty=true;}else{draft=structuredClone(result.value);dirty=false;}
    const deferred=changed.filter(f=>f.key.startsWith('tunnels.'));
    saveFeedback=deferred.length?'已保存；'+deferred.map(f=>f.label.split(' · ')[0]).join('、')+'代理需重新连接后核验。':result.applied?'已保存，运行时已确认此版本；默认值按其适用时机使用。':'已保存，运行时尚未确认应用。';
    if(editedDuringSave)saveFeedback+=' 保存期间的新编辑仍是草稿。';
    toast(saveFeedback);applyTheme();render(true);await refresh();
  }catch(err){toast(err.status===409?'保存冲突：其他窗口已更新设置。草稿已保留，请先核对新版本后再编辑保存。':err.message,true);}
  finally{if(button.isConnected){button.textContent='保存更改';updateSaveState();}}
}

async function refresh(force=false){
  if(refreshPromise)return refreshPromise;
  if(authExpired)return false;
  clearTimeout(timer);
  refreshPromise=(async()=>{
    const slow=setTimeout(()=>showConnection('后台响应较慢，继续保留上次数据；编辑内容不会改变。'),2200);
    try{
      const next=await api('state');
      if(!next?.settings?.value||!Array.isArray(next.tasks))throw new Error('状态数据不完整，暂不更新当前内容。');
      state=next;stateFresh=true;lastStateRead=Date.now();
      if(!catalog)catalog=await api('catalog');
      $('#connection-dot').className='dot good';$('#panel-state').textContent='本机后台已连接';
      $('#last-update').textContent='更新于 '+when(state.observedAt);
      $('#status-left').textContent=state.controlConnected?(state.runtime?.legacy?'兼容管理已连接':'实时管理接口已连接'):'后台在线 · 运行时未连接';
      $('#status-right').textContent='设置第 '+state.settings.value.revision+' 版';
      showConnection('');
      if(dirty){settingsConflict=state.settings.hash!==settingsDoc.hash;}
      else{
        const changed=settingsDoc&&settingsDoc.hash!==state.settings.hash;
        settingsDoc=state.settings;draft=structuredClone(settingsDoc.value);
        if(changed&&sectionFor[view])saveFeedback='其他窗口更新了已保存设置；当前已读取新版本。';
      }
      if(!$('#main h1')||$('#main .loading')||$('#main [data-connect-error]'))render();
      else if(['overview','tasks','advanced'].includes(view)||search)render(true);
      else if(sectionFor[view]){if(!dirty)patchHTML($('#main'),settingsPage());else updateSaveState();}
      else if(view==='profile')patchHTML($('#policy-explanation'),policyExplanation());
      patchRoot($('#settings-status'),settingsStatus());
      for(const [id,html]of [['operation-status',operationBox()],['candidate-status',candidateBox()]]){
        const el=$('#'+id);if(el){const template=document.createElement('template');template.innerHTML=html;syncNode(el,template.content.firstChild);}
      }
      applyTheme();syncTaskDialog();
      if(view==='usage'&&(force||Date.now()-usageUpdated>15000)&&!usageLoading)void loadUsage();
      return true;
    }catch(err){
      stateFresh=false;showConnection(err.message,true);patchRoot($('#settings-status'),settingsStatus());syncTaskDialog();
      if(!state)$('#main').innerHTML=pageHead(authExpired?'窗口认证已过期':'暂时无法读取运行状态',err.message)+'<div data-connect-error class="empty"><strong>'+(authExpired?'从桌面重新打开控制台':'检查本机后台后重试')+'</strong>此窗口无法确认当前运行情况。连接恢复后会重新读取。<p><button id="refresh-all">重新读取</button></p></div>';
      return false;
    }finally{clearTimeout(slow);}
  })();
  try{return await refreshPromise;}
  finally{refreshPromise=null;if(!authExpired)timer=setTimeout(()=>void refresh(),Math.max(2,state?.settings.value.panel.refreshSeconds||3)*1000);}
}

document.addEventListener('click',async event=>{
  const btn=event.target.closest('button');if(!btn||btn.disabled)return;
  if(btn.dataset.nav){void navigate(btn.dataset.nav);return;}
  if(btn.hasAttribute('data-dialog-close')){void closeDetail();return;}
  if(btn.dataset.quickTask){void quickTaskAction(btn.dataset.quickTask,btn.dataset.provider,btn.dataset.taskRef);return;}
  if(btn.dataset.memoryDelete){await deleteMemory(btn.dataset.memoryDelete);return;}
  if(btn.dataset.ruleDelete){await mutateRule('delete',btn.dataset.ruleDelete);return;}
  if(btn.dataset.ruleUpdate){const input=document.querySelector(`[data-rule-text="${CSS.escape(btn.dataset.ruleUpdate)}"]`);await mutateRule('update',btn.dataset.ruleUpdate,input?.value||'');return;}
  if(btn.dataset.protectedRemove!==undefined){const index=Number(btn.dataset.protectedRemove);if(houseDoc?.value?.protectedPaths?.[index]!==undefined){houseDoc.value.protectedPaths.splice(index,1);houseDirty=true;houseEditVersion++;patchHTML($('#housekeeping-form'),houseForm());}return;}
  if(btn.dataset.task){showTask(btn.dataset.provider,btn.dataset.task);return;}
  if(btn.dataset.maintenance){void maintenance(btn.dataset.maintenance,btn.dataset.lane);return;}
  if(btn.hasAttribute('data-task-page')){taskPage+=Number(btn.dataset.taskPage);patchHTML($('#task-list'),taskTable(filteredTasks()));return;}
  if(btn.hasAttribute('data-usage-page')){usagePage+=Number(btn.dataset.usagePage);updateUsageView();return;}
  if(btn.hasAttribute('data-usage-record')){showUsageRecord(Number(btn.dataset.usageRecord));return;}
  if(btn.id==='task-dismiss-history'){await dismissTaskHistoryRecord();return;}
  if(['task-cancel','task-approve','task-reject'].includes(btn.id)){await actTask(btn.id.slice(5));return;}
  try{switch(btn.id){
    case 'refresh-all':await refresh(true);break;
    case 'save-settings':await saveSettings();break;
    case 'reset-settings':settingsDoc=state.settings;draft=structuredClone(settingsDoc.value);dirty=false;settingsConflict=false;render();break;
    case 'load-memory':await loadMemory();break;
    case 'memory-add':await addMemory();break;
    case 'protected-add':{
      const value=$('#protected-new')?.value.trim();if(!value){toast('请填写要保护的文件或文件夹路径。',true);break;}
      houseDoc.value.protectedPaths??=[];if(!houseDoc.value.protectedPaths.includes(value))houseDoc.value.protectedPaths.push(value);houseDirty=true;houseEditVersion++;patchHTML($('#housekeeping-form'),houseForm());break;
    }
    case 'load-housekeeping':await loadHouse();break;
    case 'save-housekeeping':{
      for(const input of document.querySelectorAll('[data-house]'))if(!input.reportValidity())return;
      btn.disabled=true;const version=houseEditVersion,value=structuredClone(houseDoc.value);
      const data=await post('housekeeping',{value,expectedHash:houseDoc.hash});
      if(version===houseEditVersion){houseDoc=data;houseDirty=false;}else{houseDoc.hash=data.hash;houseDirty=true;}
      houseFeedback=data.applied?'清理计划已保存，运行时已重新调度。':'清理设置已保存，尚未确认应用。';toast(houseFeedback);patchHTML($('#housekeeping-form'),houseForm());break;
    }
    case 'load-profile':await loadProfile();break;
    case 'save-profile-approval':{
      const p=profileDoc.profile||profileDoc,version=profileEditVersion;btn.disabled=true;
      const data=await post('profile',{requireCallApproval:$('#call-approval').checked,instruction:p.instruction||'',expectedProfileHash:p.profileHash||p.hash,expectedProfileRevision:p.profileRevision});
      profileDoc=data;if(version===profileEditVersion){profileDirty=false;profileDraft=null;}
      toast('调用确认设置已保存。');await loadProfile();break;
    }
    case 'rule-add':await mutateRule('add',null,$('#rule-new')?.value||'');break;
    case 'load-models':{
      btn.disabled=true;const models=await api('models'),all=Object.values(models).filter(Array.isArray).flat();modelCatalog=models;
      if($('#model-list'))$('#model-list').innerHTML=[...new Set(all.map(x=>x.id))].map(id=>'<option value="'+e(id)+'"></option>').join('');
      toast('已读取 '+all.length+' 条模型记录，模型与推理强度下拉已更新。');if(['providers','concurrency'].includes(view))render(true);break;
    }
    case 'load-logs':await loadLogs();break;
    case 'export-diagnostics':btn.disabled=true;downloadJSON(await api('diagnostics'),'桥接诊断');toast('诊断文件已导出。');break;
    case 'usage-refresh':await loadUsage(true);break;
    case 'usage-export':if(usageData&&usageLoadedKey===usageKey()&&!usageError){downloadJSON(usageData,'桥接用量');toast('已导出本次查询返回的汇总和明细。');}break;
    case 'task-reopen':{
      if(taskFormDirty&&!await confirmAction('重新核对最新任务？','这会清除旧请求的填写内容。返回可继续查看原表单。','重新核对'))return;
      const t=activeTask;if(await refresh(true))showTask(t.provider,t.ref);break;
    }
  }}catch(err){toast(err.status===409?'内容已被其他窗口更新，当前编辑已保留。请先核对最新版本。':err.message,true);}
  finally{if(btn.isConnected&&!['save-settings','reset-settings'].includes(btn.id))btn.disabled=false;}
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.dataset.setting){
    const f=catalog.fields.find(x=>x.key===el.dataset.setting);putAt(draft,f.key,f.type==='boolean'?el.checked:f.type==='number'?Number(el.value):el.value);
    dirty=JSON.stringify(draft)!==JSON.stringify(settingsDoc.value);updateSaveState();
  }
  if(el.dataset.house){houseDoc.value[el.dataset.house]=el.type==='checkbox'?el.checked:Number(el.value);houseDirty=true;houseEditVersion++;}
  if(el.id==='call-approval'){profileDraft={requireCallApproval:$('#call-approval').checked};profileDirty=true;profileEditVersion++;}
  if(el.hasAttribute('data-elic'))taskFormDirty=true;
  if(el.id==='task-search'){taskSearch=el.value;taskPage=0;patchHTML($('#task-list'),taskTable(filteredTasks()));}
  if(el.id==='search'){
    if(hasDirty()){el.value='';toast('请先保存当前设置或撤销更改，再搜索其他页面。');return;}
    search=el.value.trim();if(state&&catalog)render(true);
  }
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='task-provider'){filterProvider=el.value;taskPage=0;patchHTML($('#task-list'),taskTable(filteredTasks()));}
  if(el.id==='task-status'){filterStatus=el.value;taskPage=0;patchHTML($('#task-list'),taskTable(filteredTasks()));}
  if(el.id==='memory-filter'){memoryFilter=el.value;if($('#memory-panel'))patchHTML($('#memory-panel'),memoryPanel());}
  if(el.id==='log-kind')void loadLogs();
});
document.addEventListener('submit',event=>{
  if(event.target.id!=='usage-filters')return;event.preventDefault();
  usageFilters={days:$('#usage-days').value,provider:$('#usage-provider').value,model:$('#usage-model').value.trim()};usagePage=0;
  if(usageLoadedKey!==usageKey())usageData=null;
  void loadUsage(true);
});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!$('#dialog').open&&!$('#confirm-dialog').open)$('#search').focus();}});
async function closeDetail(){
  if(taskBusy)return;
  if(taskFormDirty&&!await confirmAction('关闭前放弃已填信息？','当前填写内容尚未提交，关闭后不会保存。','放弃并关闭'))return;
  $('#dialog').close();activeTask=null;dialogMode='';taskFormDirty=false;returnFocus?.isConnected&&returnFocus.focus();
}
$('#dialog').addEventListener('cancel',event=>{event.preventDefault();void closeDetail();});
window.addEventListener('beforeunload',event=>{if(hasDirty()||taskFormDirty){event.preventDefault();event.returnValue='';}});
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyTheme);
setInterval(()=>{
  if(lastStateRead&&Date.now()-lastStateRead>Math.max(15000,(state?.settings.value.panel.refreshSeconds||3)*2500)&&stateFresh){
    stateFresh=false;showConnection('状态超过有效读取间隔，当前数据已过期，等待新的回执。',true);syncTaskDialog();
  }
},1000);
try{catalog=await api('catalog');await refresh(true);}catch(err){
  showConnection(err.message,true);
  $('#main').innerHTML=pageHead(authExpired?'窗口认证已过期':'暂时无法加载控制台',err.message)+'<div data-connect-error class="empty"><strong>'+(authExpired?'请从桌面重新打开控制台':'请检查本机后台后重新读取')+'</strong><button id="refresh-all">重新读取</button></div>';
}

function setNavigation(open){$('.shell').classList.toggle('nav-collapsed',!open);$('#toggle-navigation').textContent=open?'收起导航':'展开导航';$('#toggle-navigation').setAttribute('aria-expanded',String(open));}
$('#toggle-navigation').addEventListener('click',()=>setNavigation($('.shell').classList.contains('nav-collapsed')));
window.matchMedia('(max-width:980px)').addEventListener('change',ev=>setNavigation(!ev.matches));
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&!$('#dialog').open&&window.innerWidth<980)setNavigation(false);});
setNavigation(window.innerWidth>=980);
function alertsBox(){const issues=[];if(state.bridge.healthy===false)issues.push('桥接服务暂不可达');else if(state.bridge.healthy!==true)issues.push('桥接服务状态尚未核验');if(state.channels.some(c=>!c.connected))issues.push('有连接通道需要检查');if(state.settings.error)issues.push('管理配置需要修复');const approval=state.runtime?.counts?.awaitingApproval||0;if(approval)issues.push(`${approval} 个任务正在等待审批`);if(!issues.length)return '';return `<div class="banner ${state.bridge.healthy?'warning':'error'}"><strong>需要关注</strong>${issues.map(e).join('；')} <button class="text-button" data-nav="${approval?'tasks':'logs'}">${approval?'处理待审批任务':'查看诊断'}</button></div>`;}
function candidateBox(){const v=state?.candidateVerification;if(!v)return '<div id="candidate-status"></div>';if(v.result==='PASS')return `<div id="candidate-status" class="banner"><strong>管理候选已经验证</strong>仅在当前任务全部结束后发布。<p class="mono">${e(v.receipt?.digest||'')}</p></div>`;const reason=/browser|sandbox|trusted Node/i.test(v.error||'')?'浏览器子运行时未通过检查。当前不会替换生产，也不会因此中断任务。':'管理候选尚未完成验证，发布操作不会执行。';return `<div id="candidate-status" class="banner warning"><strong>管理版本暂未接入</strong>${reason}${v.error?`<details><summary>展开验证失败详情</summary><pre>${e(v.error)}</pre></details>`:''}</div>`;}


/* Small DOM reconciliation keeps existing controls, keyed rows and open disclosures. */
function nodeKey(n){return n.nodeType===1?(n.id||n.getAttribute('data-key')):null;}
function syncNode(old,next){
  if(old.nodeType!==next.nodeType||old.nodeName!==next.nodeName){if(old.contains?.(document.activeElement))return;old.replaceWith(next.cloneNode(true));return;}
  if(old.nodeType===3){if(old.data!==next.data)old.data=next.data;return;}
  if(old.nodeType!==1)return;
  const form=old.matches('input,select,textarea'),preserve=form&&(old===document.activeElement||old.hasAttribute('data-elic')||old.hasAttribute('data-house')&&houseDirty||old.hasAttribute('data-setting')&&dirty||['profile-instruction','call-approval'].includes(old.id)&&profileDirty);
  for(const a of [...old.attributes])if(!next.hasAttribute(a.name)&&!(old.tagName==='DETAILS'&&a.name==='open')&&!(preserve&&['value','checked','selected'].includes(a.name)))old.removeAttribute(a.name);
  for(const a of [...next.attributes])if(!(old.tagName==='DETAILS'&&a.name==='open')&&!(preserve&&['value','checked','selected'].includes(a.name))&&old.getAttribute(a.name)!==a.value)old.setAttribute(a.name,a.value);
  if(form){if(!preserve){if(old.tagName==='SELECT')syncChildren(old,next);old.value=next.value;if(old.type==='checkbox')old.checked=next.checked;}return;}
  syncChildren(old,next);
}
function syncChildren(old,next){
  let cursor=old.firstChild;
  for(const fresh of [...next.childNodes]){
    const key=nodeKey(fresh);
    let match=key?[...old.childNodes].find(n=>nodeKey(n)===key):cursor&&!nodeKey(cursor)&&cursor.nodeType===fresh.nodeType&&cursor.nodeName===fresh.nodeName?cursor:null;
    if(!match){match=fresh.cloneNode(true);old.insertBefore(match,cursor);}
    else{if(match!==cursor)old.insertBefore(match,cursor);syncNode(match,fresh);}
    cursor=match.nextSibling;
  }
  while(cursor){const following=cursor.nextSibling;if(!cursor.contains?.(document.activeElement))cursor.remove();cursor=following;}
}
function patchHTML(el,html){if(!el)return;const t=document.createElement('template');t.innerHTML=html;syncChildren(el,t.content);}
function showConnection(message,error=false){
  const box=$('#connection-notice');if(box){box.hidden=!message;box.textContent=message+(message&&state?' 上次读取：'+when(state.observedAt)+'。':'');box.className='connection-notice '+(error?'error':'');}
  if(error){$('#connection-dot').className='dot bad';$('#panel-state').textContent=authExpired?'窗口认证已过期':'数据已过期';$('#status-left').textContent='未确认当前运行状态 · 保留上次数据';}
}
function settingsStatus(){
  const saved=state?.settings,confirmed=stateFresh&&state.controlConnected&&state.runtime?.settingsHash===saved?.hash;
  return '<div id="settings-status" class="settings-status"><strong>已保存 · 第 '+e(saved?.value?.revision??'未知')+' 版</strong><p>'+(confirmed?'运行时已确认此版本；新任务默认值仍只影响新任务。':'运行时尚未确认此版本，不能据保存状态判断已应用。')+'</p><p>通道代理另以实际连接核验，修改后需要重新连接对应通道。</p></div>';
}
function updateSaveState(){
  if($('#save-settings'))$('#save-settings').disabled=!dirty;
  if($('#reset-settings'))$('#reset-settings').disabled=!dirty;
  if($('#save-note'))$('#save-note').textContent=settingsConflict?'另一个窗口已保存新版本。当前草稿仍保留；保存时会检查冲突。':dirty?'有尚未保存的更改':saveFeedback||'与已保存设置一致。';
}
function policyExplanation(){
  const p=state?.operatorPolicy;
  return '<div class="callout"><strong>人工控制与 Agent 自动化各有范围</strong><p>'+e(p?.effectiveSource||'明确人工决定优先于 Agent 默认偏好；操作仍需系统与执行器授权。')+'</p><p>面板按你核对的当前任务、轮次与请求提交决定，不会自动批准后续请求。</p>'+(p?.osElevationRequired?'<p>需要系统管理员权限的操作仍须系统授权；面板确认不绕过系统权限。</p>':'')+'</div><details><summary>查看当前规则来源与适用范围</summary><dl class="definition horizontal section"><div><dt>自动化规则</dt><dd>'+e(p?.automation?.scope||'使用现有调用规则，保存后影响新任务。')+'</dd></div><div><dt>操作者规则</dt><dd>'+e(p?.operator?.scope||'已认证窗口内明确确认的这一个操作。')+'</dd></div><div><dt>优先级</dt><dd>'+e(p?.canOverrideAgentPreferences===true?'人工明确决定优先于 Agent 偏好':p?.canOverrideAgentPreferences===false?'以后端提供的实际权限为准':'后端尚未提供优先级状态')+'</dd></div></dl></details>';
}


function usageKey(){return new URLSearchParams(Object.entries(usageFilters).filter(([,v])=>v)).toString();}
function usageShell(){
  return pageHead('用量统计','按正式回执查看Token使用情况。仅统计本机已记录数据，未知部分不补零；不会调用模型做分析。')+
  `<form id="usage-filters" class="usage-filters"><label>时间范围<select id="usage-days">${[['1','最近 1 天'],['7','最近 7 天'],['30','最近 30 天'],['90','最近 90 天']].map(([v,n])=>`<option value="${v}" ${usageFilters.days===v?'selected':''}>${n}</option>`).join('')}</select></label><label>执行器<select id="usage-provider"><option value="">全部执行器</option>${Object.entries(names).map(([v,n])=>`<option value="${v}" ${usageFilters.provider===v?'selected':''}>${n}</option>`).join('')}</select></label><label class="model-filter">模型<input id="usage-model" list="usage-models" value="${e(usageFilters.model)}" placeholder="全部模型，或填写精确标识" autocomplete="off"><datalist id="usage-models">${[...usageModels].map(v=>`<option value="${e(v)}"></option>`).join('')}</datalist></label><button class="primary" type="submit">应用筛选</button></form>
  <div class="usage-toolbar"><p id="usage-current" class="muted">${usageFilterLabel()}</p><div class="actions"><button id="usage-refresh">刷新用量</button><button id="usage-export" ${!usageData||usageLoadedKey!==usageKey()||usageLoading?'disabled':''}>导出本次结果</button></div></div><div id="usage-feedback" role="status">${usageFeedback()}</div><div id="usage-results" aria-busy="${usageLoading}">${usageReport()}</div>`;
}
function usageFilterLabel(){return '当前查询：最近 '+e(usageFilters.days)+' 天 · '+e(names[usageFilters.provider]||usageFilters.provider||'全部执行器')+' · '+e(usageFilters.model||'全部模型');}
function usageFeedback(){
  if(usageLoading)return '<div class="banner"><strong>正在读取用量</strong>按当前筛选读取本机记录。已有结果保留显示，直到新结果返回。</div>';
  if(usageError)return '<div class="banner warning"><strong>用量暂不可用</strong>'+e(usageError)+(usageData?' 当前保留上次结果，请勿当作最新统计。':' 不代表没有用量。')+'</div>';
  return '';
}
function usageReport(){
  if(!usageData)return '<div class="empty usage-empty"><strong>'+(usageLoading?'等待用量数据':'尚无可展示的统计')+'</strong>'+(usageError?'后台可能尚未接入用量接口，可稍后点击刷新。':'首次读取后会显示汇总、趋势和明细。')+'</div>';
  const d=usageData,s=d.summary||{},known=typeof s.knownTurns==='number'?s.knownTurns:null;
  const stats=[['已记录轮次',s.recordedTurns],['有总量记录的轮次',known],['用量未知轮次',s.unknownTurns],['已知记录的Token总数',s.totalTokens]];
  return `<div class="usage-period"><span>数据截至 ${e(when(d.observedAt))}</span><span>${e(when(d.period?.from,d.period?.timeZone))} — ${e(when(d.period?.to,d.period?.timeZone))} · ${e(d.period?.timeZone||'时区未提供')}</span></div><dl class="usage-summary">${stats.map(([k,v])=>`<div><dt>${e(k)}</dt><dd>${number(v)}</dd></div>`).join('')}</dl>
  <p class="footer-note">Token是模型处理文本的计量单位。总量已包含输入与输出；缓存属于输入，推理属于输出，不再相加。${s.unknownTurns>0?' 有未记录用量的轮次，已知总量不能代表全部消耗。':''}</p>
  <details class="usage-components"><summary>输入、输出与轮次状态</summary><dl class="definition horizontal section">${[['输入Token',s.inputTokens],['其中缓存输入',s.cachedInputTokens],['输出Token',s.outputTokens],['其中推理输出',s.reasoningOutputTokens],['活动轮次',s.activeTurns],['已完成轮次',s.completedTurns],['失败轮次',s.failedTurns]].map(([k,v])=>`<div><dt>${k}</dt><dd>${number(v)}</dd></div>`).join('')}<div><dt>缓存命中率（输入范围）</dt><dd>${typeof s.cacheHitRate==='number'&&Number.isFinite(s.cacheHitRate)?(s.cacheHitRate*100).toFixed(1)+'%':'未知'}</dd></div></dl></details>
  <section class="section"><div class="section-head"><h2>每日用量趋势</h2><span class="muted">已知Token · 悬停或聚焦查看数值</span></div>${usageTrend(d.byDay||[])}</section>
  <section class="section"><h2>按维度查看</h2><div class="breakdowns">${usageBreakdown('执行器',d.byProvider||[],true)}${usageBreakdown('模型',d.byModel||[])}${usageBreakdown('项目',d.byProject||[])}</div></section>
  <section class="section"><div class="section-head"><h2>记录明细</h2><span class="muted">已载入 ${(d.records||[]).length} 条</span></div>${usageRecords(d.records||[])}<p class="footer-note">导出当前筛选下已返回的 JSON，含汇总与已载入明细；若后台限制条数，导出也只包含这批记录。</p></section>
  <section class="section"><h2>数据覆盖与说明</h2><p class="footer-note">未知用量轮次：${number(d.coverage?.unknownTurns??s.unknownTurns)}。此页不提供费用、剩余额度或可用余额推算。</p>${(d.coverage?.notes||[]).map(n=>'<p class="coverage-note">'+e(n)+'</p>').join('')}${(d.insights||[]).map(i=>'<div class="insight"><strong>'+e(i.title)+'</strong><p>'+e(i.text)+'</p></div>').join('')}</section>`;
}
function usageTrend(days){
  if(!days.length)return '<div class="quiet-empty">所选时间范围尚无每日记录。缺少数据不能视为零消耗。</div>';
  const max=Math.max(1,...days.map(d=>typeof d.totalTokens==='number'?d.totalTokens:0));
  return '<div class="trend-scroll"><div class="trend" role="list" aria-label="每日已知Token趋势">'+days.map(d=>{
    const has=typeof d.totalTokens==='number'&&Number.isFinite(d.totalTokens),height=has?Math.min(100,Math.max(0,d.totalTokens/max*100)):0;
    const label=(d.label||d.key)+'：'+number(d.totalTokens)+' Token，'+number(d.turns)+' 轮，'+number(d.knownTurns)+' 轮有记录';
    const heightClass='trend-h-'+Math.max(0,Math.min(20,Math.round(height/5)));
    return `<div class="trend-day" role="listitem" tabindex="0" aria-label="${e(label)}" title="${e(label)}"><span class="trend-value">${has?shortNumber(d.totalTokens):'未知'}</span><div class="trend-track"><span class="trend-bar ${has?heightClass:'unknown'}"></span></div><span class="trend-label">${e(d.label||d.key)}</span></div>`;
  }).join('')+'</div></div><details><summary>查看每日精确数值</summary>'+simpleUsageTable(days,'日期')+'</details>';
}
function shortNumber(n){return n>=1000000?(n/1000000).toFixed(1)+' 百万':n>=10000?(n/10000).toFixed(1)+' 万':number(n);}
function simpleUsageTable(rows,label,provider=false){
  return '<div class="table-wrap"><table class="data-table"><thead><tr><th>'+label+'</th><th>轮次</th><th>已知轮次</th><th>Token总数</th></tr></thead><tbody>'+rows.map(r=>'<tr data-key="'+e(r.key)+'"><td>'+e(provider?names[r.key]||r.label||r.key:r.label||r.key||'未提供')+'</td><td>'+number(r.turns)+'</td><td>'+number(r.knownTurns)+'</td><td>'+number(r.totalTokens)+'</td></tr>').join('')+'</tbody></table></div>';
}
function usageBreakdown(label,rows,open=false){
  return '<details '+(open?'open':'')+'><summary>按'+label+' · '+rows.length+' 项</summary>'+(rows.length?simpleUsageTable(rows,label,label==='执行器'):'<p class="muted">当前维度尚无数据。</p>')+'</details>';
}
function usageRecords(records){
  if(!records.length)return '<div class="empty"><strong>当前筛选没有记录</strong>可扩大时间范围或清除执行器和模型筛选；未记录的数据无法在此补齐。</div>';
  const pages=Math.ceil(records.length/50);usagePage=Math.min(usagePage,pages-1);
  return '<div class="table-wrap"><table class="data-table usage-table"><thead><tr><th>任务 / 项目</th><th>执行器 / 模型</th><th>状态</th><th>Token总数</th><th>详情</th></tr></thead><tbody>'+records.slice(usagePage*50,(usagePage+1)*50).map((r,i)=>`<tr data-key="${e(r.provider+':'+r.agentRef+':'+r.turnId)}"><td><div class="clamp">${e(r.title||'未命名任务')}</div><small class="muted break-word">${e(r.project||'项目未提供')}</small></td><td>${e(names[r.provider]||r.provider)}<div class="mono">${e(r.model||'模型未提供')}</div></td><td>${pill(r.status)}<small class="muted">${e(when(r.startedAt))}</small></td><td class="numeric">${number(r.usage?.totalTokens)}</td><td><button data-usage-record="${usagePage*50+i}">详情</button></td></tr>`).join('')+'</tbody></table></div>'+ `<div class="pagination"><span>每页最多 50 条</span><div><button data-usage-page="-1" ${usagePage===0?'disabled':''}>上一页</button><span>${usagePage+1} / ${pages}</span><button data-usage-page="1" ${usagePage>=pages-1?'disabled':''}>下一页</button></div></div>`;
}
function updateUsageView(){
  if(view!=='usage'||search)return;
  patchHTML($('#usage-feedback'),usageFeedback());patchHTML($('#usage-results'),usageReport());
  $('#usage-results')?.setAttribute('aria-busy',String(usageLoading));
  if($('#usage-current'))$('#usage-current').innerHTML=usageFilterLabel();
  if($('#usage-export'))$('#usage-export').disabled=!usageData||usageLoadedKey!==usageKey()||usageLoading||!!usageError;
  patchHTML($('#usage-models'),[...usageModels].map(v=>'<option value="'+e(v)+'"></option>').join(''));
}
async function loadUsage(force=false){
  const key=usageKey();if(usageLoading&&!force)return;
  usageController?.abort();usageController=new AbortController();const seq=++usageSequence;
  usageLoading=true;usageError='';updateUsageView();
  try{
    const data=await api('usage?'+key,{signal:usageController.signal});
    if(seq!==usageSequence)return;
    if(!data?.summary||!Array.isArray(data.records))throw new Error('用量响应格式不完整，无法确认统计。');
    usageData=data;usageLoadedKey=key;usageUpdated=Date.now();
    for(const r of data.byModel||[])if(r.key)usageModels.add(r.key);
    for(const r of data.records)if(r.model)usageModels.add(r.model);
  }catch(err){if(seq===usageSequence)usageError=err.status===404?'后台尚未提供用量接口，请等待接入后刷新。':err.message;}
  finally{if(seq===usageSequence){usageLoading=false;updateUsageView();}}
}
function showUsageRecord(index){
  const r=usageData?.records?.[index];if(!r)return;
  dialogMode='usage';activeTask=null;taskFormDirty=false;returnFocus=document.activeElement;
  $('#dialog-content').innerHTML=`<div class="dialog-head"><h2 id="dialog-title">用量记录详情</h2><button data-dialog-close>关闭</button></div><div class="dialog-body"><h3>${e(r.title||'未命名任务')}</h3><p class="muted">这是打开时的记录快照，统计页面继续按后台回执更新。</p><dl class="definition horizontal section">${[['执行器',names[r.provider]||r.provider],['模型',r.model||'未提供'],['项目',r.project||'未提供'],['开始时间',when(r.startedAt)],['结束时间',when(r.endedAt)],['更新于',when(r.updatedAt)],['Token总数',number(r.usage?.totalTokens)],['输入',number(r.usage?.inputTokens)],['缓存输入（输入子集）',number(r.usage?.cachedInputTokens)],['输出',number(r.usage?.outputTokens)],['推理输出（输出子集）',number(r.usage?.reasoningOutputTokens)]].map(([k,v])=>`<div><dt>${k}</dt><dd class="break-word">${e(v)}</dd></div>`).join('')}</dl><p class="footer-note">来源与完整度保留后台证据；空值表示未知，不作为零计算。</p><details><summary>来源、完整度与原始记录</summary><pre class="evidence">${e(JSON.stringify(r,null,2))}</pre></details></div><div class="dialog-foot"><button data-dialog-close>关闭</button></div>`;
  $('#dialog').showModal();
}
function downloadJSON(data,prefix){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=prefix+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}


/* Handle Escape once at the topmost dialog; native stacked close watchers may cascade. */
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  if($('#confirm-dialog').open){event.preventDefault();event.stopImmediatePropagation();$('#confirm-no').click();}
  else if($('#dialog').open){event.preventDefault();event.stopImmediatePropagation();void closeDetail();}
},true);
document.addEventListener('keyup',event=>{
  if(event.key==='Escape'&&($('#confirm-dialog').open||$('#dialog').open)){event.preventDefault();event.stopImmediatePropagation();}
},true);

function patchRoot(el,html){if(!el)return;const t=document.createElement('template');t.innerHTML=html;syncNode(el,t.content.firstChild);}
