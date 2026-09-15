import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readSettings, DEFAULT_SETTINGS, controlEndpoint, atomicWrite, hashText, redact, PROVIDERS } from './operator-settings.mjs';
import { UsageLedger } from './operator-usage.mjs';

const ACTIVE = new Set(['starting', 'queued', 'processing', 'running', 'awaitingApproval', 'cancelling']);
const payloadOf = result => result?.structuredContent ?? result ?? {};
const refOf = p => p.agentRef ?? p.ref ?? null;
const normalProvider = id => id === 'codex' ? 'codex-a' : id;
function projectKey(value) {
  if (!value) return null;
  let key; try { key = fs.realpathSync(value); } catch { key = path.resolve(value); }
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
function deny(message, code = 'OPERATOR_CAPACITY_LIMIT') { const error = new Error(message); error.code = code; throw error; }
function sameToken(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

export class RuntimeOperator {
  constructor({ root, port = 7690, memory = null }) {
    this.root = root; this.port = port; this.memory = memory;
    this.settings = structuredClone(DEFAULT_SETTINGS); this.settingsHash = null; this.configError = null;
    this.codex = new Map(); this.adapters = new Map(); this.metadata = new Map(); this.foreign = new Map();
    this.reservations = new Map(); this.requests = new Map(); this.rejected = 0; this.commandGate = null;
    this.drainingUntil = 0; this.server = null; this.handlers = null; this.polling = false; this.lastPollError = null;
    this.usageLedger = null; this.usageError = null;
    this.reload();
  }
  reload() {
    try { const doc = readSettings(this.root); this.settings = doc.value; this.settingsHash = doc.hash; this.configError = null;
      if (this.memory) this.memory.enabled = this.settings.memory.enabled && Boolean(this.memory.store);
    } catch (e) { this.configError = e.message; }
    return { revision: this.settings.revision, hash: this.settingsHash, error: this.configError };
  }
  rows() {
    const rows = [];
    for (const [provider, executor] of this.codex) {
      for (const raw of executor.operatorSnapshot?.() ?? []) {
        const meta = this.metadata.get(`${provider}:${raw.ref}`) ?? {};
        rows.push({ ...meta, ...raw, provider, title: meta.title || '任务详情见历史记录', live: true });
      }
    }
    for (const [provider, adapter] of this.adapters) {
      if (typeof adapter.listJobs === 'function') for (const job of adapter.listJobs()) {
        const ref = refOf(job); if (!ref) continue;
        this.foreign.set(`${provider}:${ref}`, { ref, provider, cwd:job.cwd||job.workspace||job.project, status:job.status||'unknown',model:job.model,startedAt:job.startedAt,updatedAt:job.finishedAt||Date.now(),endedAt:job.finishedAt||null,turnId:ref,result:job.response||null,usage:job.usage??null,usageScope:'turn' });
      }
    }
    for (const [key, value] of this.foreign) rows.push({ ...(this.metadata.get(key) ?? {}), ...value, live: true });
    return rows;
  }
  countedRows() {
    const rows = this.rows().filter(r => ACTIVE.has(r.status) || (r.status === 'unknown' && r.turnId && !r.endedAt));
    return this.settings.admission.countApprovals ? rows : rows.filter(r => r.status !== 'awaitingApproval');
  }
  admission(provider, meta) {
    this.reload();
    if (this.configError) deny('管理设置格式错误，已暂停新任务，请在控制台修复设置。', 'OPERATOR_CONFIG_INVALID');
    provider = normalProvider(provider);
    const cfg = this.settings; const p = cfg.providers[provider];
    if (this.drainingUntil > Date.now()) deny('服务已进入维护等待，暂不启动新任务。', 'OPERATOR_MAINTENANCE');
    if (cfg.admission.paused) deny('控制台已暂停接收新任务。现有任务不会中断。', 'OPERATOR_ADMISSION_PAUSED');
    if (p?.enabled === false) deny('此执行器已在控制台停用新任务。', 'OPERATOR_PROVIDER_DISABLED');
    const live = this.countedRows();
    const reserved = [...this.reservations.values()].filter(r => !live.some(l => l.provider === r.provider && ((l.requestId && l.requestId === r.requestId) || (r.ref && r.ref === l.ref))));
    const rows = [...live, ...reserved];
    const exceed = (limit, n) => limit > 0 && n >= limit;
    const key = projectKey(meta.cwd);
    if (exceed(cfg.admission.maxActive, rows.length)) deny(`全部任务并发已达上限（${cfg.admission.maxActive}）。请等待已有任务结束后再提交；本次未启动模型。`);
    if (exceed(p?.maxActive, rows.filter(r => r.provider === provider).length)) deny(`此执行器并发已达上限（${p.maxActive}）。本次未启动模型。`);
    if (key && exceed(cfg.admission.maxPerProject, rows.filter(r => projectKey(r.cwd) === key).length)) deny(`该项目并发已达上限（${cfg.admission.maxPerProject}）。本次未启动模型。`);
    if (cfg.admission.focusModel && (!meta.model || meta.model === cfg.admission.focusModel) && exceed(cfg.admission.focusLimit, rows.filter(r => !r.model || r.model === cfg.admission.focusModel).length)) deny('该模型的独立并发名额已用完，本次未启动模型。');
    const id = randomUUID(); this.reservations.set(id, { ...meta, provider });
    return () => this.reservations.delete(id);
  }
  runBound(provider, kind, args, invoke, meta) {
    const id = args?.clientRequestId ?? args?.options?.requestId ?? null;
    const key = id ? `${provider}:${kind}:${id}` : null;
    const hash = hashText(JSON.stringify(args));
    const prior = key && this.requests.get(key);
    if (prior) { if (prior.hash !== hash) return Promise.reject(Object.assign(new Error('请求编号已被另一组参数使用。'), { code: 'OPERATOR_REQUEST_CONFLICT' })); return prior.succeeded && provider.startsWith('codex-') ? Promise.resolve().then(invoke) : prior.promise; }
    let release;
    try { release = this.admission(provider, { ...meta, requestId: id }); } catch(e) { this.rejected++; return Promise.reject(e); }
    const promise = (async () => {
      try {
        const result = await invoke(); const p = payloadOf(result); const ref = refOf(p);
        if (ref) this.metadata.set(`${provider}:${ref}`, { ...this.metadata.get(`${provider}:${ref}`), title: String(meta.task || '任务').slice(0, 4000), cwd: meta.cwd, requestId: id, model: meta.model, effort: meta.effort, reason: meta.reason ? String(meta.reason).slice(0, 4000) : null, source: meta.source || null, startedAt: Date.now() });
        return result;
      } finally { release(); }
    })();
    if (key) {
      const entry = { hash, promise, settled: false, succeeded: false }; this.requests.set(key, entry);
      promise.then(result => { entry.settled = true; entry.succeeded = !result?.isError && Boolean(refOf(payloadOf(result))); }, () => { entry.settled = true; });
      if (this.requests.size > 2000) { const oldest = [...this.requests].find(([,v]) => v.settled); if (oldest) this.requests.delete(oldest[0]); }
    }
    return promise;
  }
  recordUsage(provider, row) {
    if (!this.usageLedger || !row) return;
    try {
      this.usageLedger.record({ ...this.metadata.get(`${provider}:${row.ref}`), ...row, provider, runtimePid: process.pid, live: true });
      this.usageError = null;
    } catch (e) { this.usageError = e.message; }
  }
  attachCodex(provider, executor) {
    if (!executor || this.codex.has(provider)) return;
    this.codex.set(provider, executor);
    executor.setOperatorObserver?.(row => this.recordUsage(provider, row));
    const start = executor.start.bind(executor), send = executor.send.bind(executor);
    executor.start = args => this.runBound(provider, 'start', args, () => start(args), { task: args.task, cwd: args.cwd || this.root, model: args.model, effort: args.reasoningEffort, reason: args.invocationRationale, source: 'codex.agent_start' });
    executor.send = args => {
      const current = this.rows().find(r => r.provider === provider && r.ref === args.agentRef);
      // Delegate invalid active-turn sends to the existing exact-turn guard; never count them as new work.
      if (current && ACTIVE.has(current.status)) return send(args);
      return this.runBound(provider, 'send', args, () => send(args), { ref: args.agentRef, task: args.message, cwd: current?.cwd || this.root, model: args.model || current?.model, effort: args.reasoningEffort || current?.effort });
    };
  }
  attachProvider(provider, adapter) {
    if (!adapter || this.adapters.has(provider)) return;
    this.adapters.set(provider, adapter);
    const start = adapter.start.bind(adapter), send = adapter.send.bind(adapter);
    const remember = result => { const p = payloadOf(result); const ref = refOf(p); if (ref) this.foreign.set(`${provider}:${ref}`, { ref, provider, status: p.status || 'unknown', model: p.model || null, startedAt: p.startedAt || Date.now(), updatedAt: Date.now(), endedAt: p.finishedAt || null, turnId: ref }); return result; };
    adapter.start = args => this.runBound(provider, 'start', args, async () => remember(await start(args)), { task: args.task, cwd: args.project || this.root, model: args.options?.model, effort: args.options?.reasoningEffort, reason: args.options?.invocationRationale, source: 'spike.agent_start' });
    adapter.send = (ref, message, options) => this.runBound(provider, 'send', { ref, message, options }, async () => remember(await send(ref, message, options)), { task: message, cwd: options?.project || this.metadata.get(`${provider}:${ref}`)?.cwd || this.root, model: options?.model });
  }
  wrapTool(name, handler) {
    if (!['spike.agent_start', 'codex.agent_start'].includes(name)) return handler;
    return (input = {}, ...rest) => {
      this.reload(); const provider = name === 'spike.agent_start' ? normalProvider(input.provider) : 'codex-a';
      const defaults = this.settings.providers[provider];
      let args = input;
      if (defaults && name === 'spike.agent_start') {
        const options = { ...(input.options ?? {}) };
        if (!options.model && defaults.defaultModel) options.model = defaults.defaultModel;
        if (!options.reasoningEffort && defaults.defaultEffort && (!input.options?.model || input.options.model === defaults.defaultModel)) options.reasoningEffort = defaults.defaultEffort;
        args = { ...input, options };
      } else if (defaults) {
        args = { ...input };
        if (!args.model && defaults.defaultModel) args.model = defaults.defaultModel;
        if (!args.reasoningEffort && defaults.defaultEffort && (!input.model || input.model === defaults.defaultModel)) args.reasoningEffort = defaults.defaultEffort;
      }
      return handler(args, ...rest);
    };
  }
  commandLimit() { this.reload(); return this.settings.commands.maxConcurrent; }
  health() { const tasks=this.rows(); return { counts: {active:tasks.filter(r=>ACTIVE.has(r.status)).length,starting:this.reservations.size,uncertain:tasks.filter(r=>r.status==='unknown'&&!r.endedAt).length}, settingsRevision:this.settings.revision }; }
  snapshot() {
    this.reload(); const tasks = this.rows(); const counted = this.countedRows();
    return redact({ schemaVersion: 1, pid: process.pid, observedAt: new Date().toISOString(), settingsRevision: this.settings.revision, settingsHash: this.settingsHash, configError: this.configError, admission: { ...this.settings.admission, maintenance: this.drainingUntil > Date.now() },
      counts: { active: tasks.filter(r => ['starting', 'queued', 'processing', 'running', 'cancelling'].includes(r.status)).length, awaitingApproval: tasks.filter(r => r.status === 'awaitingApproval').length, counted: counted.length, starting: this.reservations.size, rejected: this.rejected, uncertain: tasks.filter(r=>r.status==='unknown').length },
      tasks: tasks.filter(r => ACTIVE.has(r.status) || r.status === 'unknown').concat(tasks.filter(r => !ACTIVE.has(r.status) && r.status !== 'unknown').sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,this.settings.panel.historyLimit)), providers: PROVIDERS.map(id => ({ id, available: this.codex.has(id) ? Boolean(this.codex.get(id).running) : this.adapters.has(id), active: counted.filter(r => r.provider === id).length, ...this.settings.providers[id] })),
      commands: { ...(this.commandGate?.snapshot?.() ?? { inFlight: 0, activeWriterProjects: [] }), limit: this.settings.commands.maxConcurrent },
      memory: this.memory?.status?.() ?? null, lastPollError: this.lastPollError,
      usageRecording: { enabled: Boolean(this.usageLedger), error: this.usageError, independentOfWindow: true } });
  }
  async refreshForeign() {
    if (this.polling) return; this.polling = true;
    try { for (const [key, entry] of this.foreign) { if (!ACTIVE.has(entry.status)) continue; const adapter = this.adapters.get(entry.provider); try { const p = await Promise.race([adapter.status(entry.ref), new Promise((_,reject) => { const timer = setTimeout(()=>reject(new Error('执行器状态读取超时。')),5000); timer.unref(); })]); this.foreign.set(key, { ...entry, status: p.status || 'unknown', model:p.model||entry.model, updatedAt: Date.now(), endedAt: p.finishedAt || null, usage:p.usage??entry.usage??null,usageScope:'turn' }); } catch (e) { this.lastPollError = e.message; } } }
    finally { this.polling = false; for(const row of this.rows().filter(r=>!r.provider.startsWith('codex-')))this.recordUsage(row.provider,row); }
  }
  async dispatch(method, params = {}) {
    if (method === 'maintenance') { this.drainingUntil = params.enabled === true ? Number.POSITIVE_INFINITY : 0; return this.snapshot(); }
    if (method === 'snapshot') return this.snapshot();
    if (method === 'reload') { const r = this.reload(); if (r.error) throw new Error(r.error); return r; }
    if (method === 'models') {
      const out = {};
      for (const [id, executor] of this.codex) { try { const r = await executor.listModels({ limit: 100, includeHidden: false }); out[id] = (r.models ?? r.data ?? []).map(m => ({ id: m.model || m.id, name: m.displayName || m.display_name || m.model || m.id, efforts: (m.supportedReasoningEfforts ?? m.supported_reasoning_levels ?? []).map(x => x.reasoningEffort || x.effort || x) })); } catch (e) { out[id] = { error: e.message }; } }
      return out;
    }
    if (method === 'profile') {
      if (!this.handlers?.get('codex.call_profile')) throw new Error('调用规则入口尚未就绪。');
      if (!['show', 'save'].includes(params.action)) throw new Error('不支持此调用规则操作。');
      return this.handlers.get('codex.call_profile')(params);
    }
    if (method === 'memory') {
      if (!this.memory?.store) throw new Error('Memory Core 当前不可用。');
      if (params.action === 'list') {
        const items=this.memory.exportSanitized().items.sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||''))).slice(0,Math.max(1,Math.min(1000,Number(params.limit)||300)));
        return { status:this.memory.status(), items };
      }
      if (params.action === 'add') {
        const title=String(params.title||'').trim(),summary=String(params.summary||'').trim(),scope=String(params.scope||'').trim();
        if(!title||title.length>500||!summary||summary.length>8000||!['global','machine','provider','project','tool'].includes(scope))throw new Error('Memory 内容或层级无效。');
        if(scope==='provider'&&!params.provider||scope==='project'&&!params.project||scope==='tool'&&!params.tool)throw new Error('所选 Memory 层级需要填写对应范围。');
        return this.memory.rememberExplicit({explicitUserIntent:true,title,summary,scope,provider:params.provider||null,project:params.project||null,tool:params.tool||null,tags:Array.isArray(params.tags)?params.tags.slice(0,20):[]});
      }
      if (params.action === 'delete') {
        if(typeof params.id!=='string'||!params.id)throw new Error('Memory ID 无效。');
        return { deleted:this.memory.forget(params.id), id:params.id };
      }
      throw new Error('不支持此 Memory 操作。');
    }
    if (method === 'task') {
      const { provider, ref, action, requestId } = params;
      if (!PROVIDERS.includes(provider) || typeof ref !== 'string' || !ref || !['cancel', 'approve', 'reject'].includes(action) || typeof requestId !== 'string' || !requestId || requestId.length > 512) throw new Error('任务操作参数无效。');
      const task = this.rows().find(r => r.ref === ref && r.provider === provider);
      if (!task) throw new Error('任务不属于当前运行实例，不能对历史记录发送控制命令。');
      if (provider.startsWith('codex-')) {
        const executor = this.codex.get(provider);
        if (action === 'cancel') {
          if (!params.expectedTurnId || params.expectedTurnId !== task.turnId) throw new Error('任务轮次已变化，请刷新详情后重新确认停止。');
          const handler = this.handlers?.get('codex.agent_cancel');
          if (handler) return handler({ agentRef: ref, expectedTurnId: params.expectedTurnId, requestId });
          return executor.cancel({ agentRef: ref, expectedTurnId: params.expectedTurnId, clientRequestId: requestId });
        }
        if (!params.approvalRequestId || String(task.pendingApproval?.requestId) !== String(params.approvalRequestId)) throw new Error('审批请求已经变化，请重新打开任务详情。');
        const handler = this.handlers?.get(action === 'approve' ? 'codex.agent_approve' : 'codex.agent_reject');
        if (handler) return handler({ agentRef: ref, approvalRequestId: String(params.approvalRequestId), requestId, ...(action === 'approve' && params.elicitationContent ? { elicitationContent: params.elicitationContent } : {}) });
        return executor.resolveApproval({ agentRef: ref, approvalRequestId: params.approvalRequestId, clientRequestId: requestId, decision: action, elicitationContent: params.elicitationContent ?? null });
      }
      if (action !== 'cancel') throw new Error('该执行器不支持此类审批。');
      return this.adapters.get(provider).cancel(ref, { requestId });
    }
    if (method === 'housekeeping' && this.housekeeping) {
      if (params.action === 'reload') { this.housekeeping.stop(); await this.housekeeping.start({ runOnStart: false }); return this.housekeeping.status(); }
      if (['preview', 'run'].includes(params.action)) return this.housekeeping.runOnce({ reason: 'operator', dryRun: params.action === 'preview' });
      throw new Error('不支持的清理操作。');
    }
    throw new Error('不支持的本机管理操作。');
  }
  async listen({ handlers, housekeeping } = {}) {
    this.handlers = handlers; this.housekeeping = housekeeping;
    try { this.usageLedger = new UsageLedger({ root: this.root, port: this.port }); }
    catch (e) { this.usageError = e.message; }
    const dir = path.join(this.root, 'state', 'operator'); fs.mkdirSync(dir, { recursive: true });
    this.token = randomBytes(32).toString('hex'); this.endpoint = controlEndpoint(this.root, this.port);
    this.server = net.createServer(socket => {
      socket.setEncoding('utf8');
      socket.setTimeout(15000, () => socket.destroy()); let buffer = ''; let done = false;
      socket.on('data', chunk => {
        if (done) return; buffer += chunk.toString('utf8'); if (Buffer.byteLength(buffer) > 262144) { done = true; socket.destroy(); return; }
        const end = buffer.indexOf('\n'); if (end < 0) return; done = true;
        void (async () => {
          try { const input = JSON.parse(buffer.slice(0, end)); if (!sameToken(input.token, this.token)) throw new Error('本机管理认证失败。'); const result = await this.dispatch(input.method, input.params); socket.end(JSON.stringify({ ok: true, result: redact(result) }) + '\n'); }
          catch (e) { socket.end(JSON.stringify({ ok: false, error: redact(e.message), code: e.code || 'OPERATOR_ERROR' }) + '\n'); }
        })();
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.endpoint, resolve); });
    this.receipt = path.join(dir, `runtime-${this.port}.json`);
    atomicWrite(this.receipt, JSON.stringify({ pid: process.pid, endpoint: this.endpoint, token: this.token, port: this.port, startedAt: new Date().toISOString() }));
    this.timer = setInterval(() => void this.refreshForeign(), 5000); this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    for (const [provider, executor] of this.codex) {
      for (const row of executor.operatorSnapshot?.() ?? []) this.recordUsage(provider, row);
      executor.setOperatorObserver?.(null);
    }
    this.usageLedger?.close(); this.usageLedger = null;
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.receipt) { try { const r = JSON.parse(fs.readFileSync(this.receipt, 'utf8')); if (r.pid === process.pid) fs.unlinkSync(this.receipt); } catch {} }
  }
}
