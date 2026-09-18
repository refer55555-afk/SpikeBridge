import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PROVIDERS = ['codex-a', 'codex-b', 'zcode', 'mac'];
export const PROVIDER_NAMES = { 'codex-a': 'Codex A', 'codex-b': 'Codex B', zcode: 'ZCode', mac: 'Mac' };
export const DEFAULT_SETTINGS = {
  schemaVersion: 1, revision: 0,
  admission: { paused: false, maxActive: 0, maxPerProject: 0, countApprovals: true, focusModel: 'gpt-6-astra', focusLimit: 0 },
  commands: { maxConcurrent: 4 },
  providers: Object.fromEntries(PROVIDERS.map(id => [id, { enabled: true, maxActive: 0, defaultModel: '', defaultEffort: '' }])),
  memory: { enabled: true },
  panel: { refreshSeconds: 3, historyLimit: 200, logLines: 200, theme: 'light' },
  recovery: { enabled: true, intervalSeconds: 60, failureThreshold: 3, cooldownSeconds: 180 },
  tunnels: { a: { proxyUrl: 'http://127.0.0.1:7890' }, b: { proxyUrl: 'http://127.0.0.1:7890' } },
};
export const SETTINGS_FIELDS = [
  { key: 'admission.paused', section: '并发与调度', label: '暂停接收新任务', type: 'boolean', effect: '立即生效', help: '现有任务继续运行，后续启动和续聊会被明确拒绝；不会中断已有任务。' },
  { key: 'admission.maxActive', section: '并发与调度', label: '全部任务并发上限', type: 'number', min: 0, max: 64, effect: '立即生效', help: '0 表示不设上限。超额请求直接拒绝，不静默排队或自动重放。降低上限不会终止现有任务。' },
  { key: 'admission.maxPerProject', section: '并发与调度', label: '同一项目任务上限', type: 'number', min: 0, max: 64, effect: '立即生效', help: '按实际工作目录计数，包含只读任务。0 表示不另设限制。' },
  { key: 'admission.countApprovals', section: '并发与调度', label: '等待审批也占用并发名额', type: 'boolean', effect: '立即生效', help: '推荐开启。关闭只改变计数，并不会释放等待中任务占用的系统资源。' },
  { key: 'admission.focusModel', section: '并发与调度', label: '单独限制的模型', type: 'model', effect: '立即生效', help: '从当前可用或近期实际使用的模型中选择。单独限制与全部任务限制同时生效，不改变调用授权。' },
  { key: 'admission.focusLimit', section: '并发与调度', label: '该模型并发上限', type: 'number', min: 0, max: 64, effect: '立即生效', help: '0 表示不另设限制。模型调用仍遵守现行调用规则。' },
  { key: 'commands.maxConcurrent', section: '并发与调度', label: '本地命令并发上限', type: 'number', min: 1, max: 4, effect: '立即生效', help: '仅限制非模型命令；同一受信项目仍保持最多一个写入者。' },
  ...PROVIDERS.flatMap(id => [
    { key: `providers.${id}.enabled`, section: '执行器设置', label: `${PROVIDER_NAMES[id]} · 接收新任务`, type: 'boolean', effect: '立即生效', help: '只影响新启动与续聊，不会关闭正在运行的执行器。' },
    { key: `providers.${id}.maxActive`, section: '执行器设置', label: `${PROVIDER_NAMES[id]} · 并发上限`, type: 'number', min: 0, max: 64, effect: '立即生效', help: '0 表示不为这个 Agent 单独设上限；仍会受到全部任务、项目和单模型限制。' },
    { key: `providers.${id}.defaultModel`, section: '执行器设置', label: `${PROVIDER_NAMES[id]} · 默认模型`, type: 'model', effect: '下一次新任务', help: '留空保留原有模型选择。只补充未指定模型的新任务，绝不覆盖调用方的明确选择。' },
    { key: `providers.${id}.defaultEffort`, section: '执行器设置', label: `${PROVIDER_NAMES[id]} · 默认推理强度`, type: 'effort', effect: '下一次新任务', help: '根据所选模型公开的推理档位选择；留空表示继续让调用方或模型默认规则决定。' },
  ]),
  { key: 'memory.enabled', section: '记忆与清理', label: '使用经验记忆', type: 'boolean', effect: '下一次工具调用', help: '关闭后暂停经验注入和经验记录，既有数据库不会删除。账号和项目隔离始终保留。' },
  { key: 'recovery.enabled', section: '启动与恢复', label: '桥接服务异常时自动恢复', type: 'boolean', effect: '立即生效', help: '面板后台连续探测失败后，仅调用安全启动的恢复入口；健康服务不重启，也不自动发布候选。' },
  { key: 'recovery.intervalSeconds', section: '启动与恢复', label: '后台恢复检查间隔（秒）', type: 'number', min: 15, max: 600, effect: '立即生效', help: '关闭窗口后，面板后台仍继续检查。' },
  { key: 'recovery.failureThreshold', section: '启动与恢复', label: '连续失败多少次后尝试恢复', type: 'number', min: 2, max: 10, effect: '立即生效', help: '避免一次短暂抖动触发恢复。' },
  { key: 'recovery.cooldownSeconds', section: '启动与恢复', label: '两次恢复之间最短间隔（秒）', type: 'number', min: 60, max: 3600, effect: '立即生效', help: '同时遵守安全启动自身的熔断规则。' },
  { key: 'tunnels.a.proxyUrl', section: '连接通道', label: 'Bridge A · Remote Proxy', type: 'string', effect: '重连 Bridge A 后', help: '这是 Bridge A 连接远端控制平面时使用的网络代理，不是给 Agent 提供通用上网能力，也不会代理本机 127.0.0.1:7690。留空表示直连。' },
  { key: 'tunnels.b.proxyUrl', section: '连接通道', label: 'Bridge B · Remote Proxy', type: 'string', effect: '重连 Bridge B 后', help: '这是 Bridge B 自己连远端服务时的网络出口。A/B 可分别设置；修改后只需重连对应 Bridge 通道。不能在地址中保存用户名或密码。' },
  { key: 'panel.refreshSeconds', section: '显示设置', label: '面板刷新间隔（秒）', type: 'number', min: 2, max: 60, effect: '立即生效', help: '只刷新管理面板数据，不生成聊天任务卡，不发起模型调用。' },
  { key: 'panel.historyLimit', section: '显示设置', label: '最多显示多少条任务记录', type: 'number', min: 20, max: 1000, effect: '立即生效', help: '只改变显示数量，不删除任务记录。' },
  { key: 'panel.logLines', section: '显示设置', label: '日志尾部行数', type: 'number', min: 50, max: 1000, effect: '立即生效', help: '日志在显示和导出前做敏感内容遮盖。' },
  { key: 'panel.theme', section: '显示设置', label: '外观', type: 'select', options: [['light', '明亮'], ['dark', '暗色'], ['system', '跟随系统']], effect: '立即生效', help: '独立窗口与浏览器访问使用相同的外观设置。' },
];
export const HOUSEKEEPING_FIELDS = [
  { key: 'enabled', label: '启用自动清理', type: 'boolean' },
  { key: 'intervalMinutes', label: '清理检查间隔（分钟）', min: 5, max: 1440 },
  { key: 'tmpQuarantineAfterHours', label: '临时文件多久后移入隔离区（小时）', min: 1, max: 720 },
  { key: 'logQuarantineAfterDays', label: '日志保留天数', min: 1, max: 365 },
  { key: 'rootEphemeralAfterHours', label: '带临时标记的文件保留时间（小时）', min: 1, max: 720 },
  { key: 'quarantinePurgeAfterDays', label: '隔离区额外保留天数', min: 1, max: 90 },
  { key: 'maxScanEntries', label: '每轮最多扫描条目', min: 100, max: 100000 },
  { key: 'maxHistoryLines', label: '清理历史最多保留行数', min: 20, max: 5000 },
];
export const HOUSEKEEPING_DEFAULTS = { enabled: true, intervalMinutes: 60, tmpQuarantineAfterHours: 6, logQuarantineAfterDays: 7, rootEphemeralAfterHours: 6, quarantinePurgeAfterDays: 2, maxScanEntries: 20000, maxHistoryLines: 200, protectedPaths: [] };
export const getAt = (value, key) => key.split('.').reduce((a, b) => a?.[b], value);
export function putAt(value, key, data) { const parts = key.split('.'); const last = parts.pop(); const obj = parts.reduce((a, b) => a[b], value); obj[last] = data; }
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是一个对象。');
  const result = structuredClone(DEFAULT_SETTINGS);
  const allowed = new Set(SETTINGS_FIELDS.map(f => f.key));
  function visit(v, prefix = '') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`设置分组无效：${prefix}`);
    for (const [key, val] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('设置包含不允许的属性。');
      const full = prefix ? `${prefix}.${key}` : key;
      if (['schemaVersion', 'revision'].includes(full)) continue;
      if (allowed.has(full)) continue;
      if ([...allowed].some(k => k.startsWith(full + '.'))) visit(val, full);
      else throw new Error(`不支持的设置：${full}`);
    }
  }
  visit(input);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error('设置文件版本不兼容。');
  for (const f of SETTINGS_FIELDS) {
    const v = (getAt(input, f.key) === undefined ? getAt(result, f.key) : getAt(input, f.key));
    if (f.type === 'boolean' && typeof v !== 'boolean') throw new Error(`${f.label}必须为开或关。`);
    if (f.type === 'number' && (!Number.isInteger(v) || v < f.min || v > f.max)) throw new Error(`${f.label}必须在 ${f.min} 到 ${f.max} 之间。`);
    if (['string', 'model', 'select'].includes(f.type) && (typeof v !== 'string' || v.length > 512 || /[\r\n\x00]/.test(v))) throw new Error(`${f.label}内容无效。`);
    if (f.options && !f.options.some(([x]) => x === v)) throw new Error(`${f.label}选项无效。`);
    if (f.key.endsWith('proxyUrl') && v) { let u; try { u = new URL(v); } catch { throw new Error(`${f.label}不是有效地址。`); } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error(`${f.label}只支持不含密码、路径和参数的代理地址。`); }
    putAt(result, f.key, typeof v === 'string' ? v.trim() : v);
  }
  result.revision = Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0;
  return result;
}
export function validateHousekeeping(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('清理设置无效。');
  const out = { ...HOUSEKEEPING_DEFAULTS };
  for (const key of Object.keys(input)) if (!(key in out)) throw new Error(`不支持的清理设置：${key}`);
  for (const f of HOUSEKEEPING_FIELDS) {
    const v = (input[f.key] === undefined ? out[f.key] : input[f.key]);
    if (f.type === 'boolean' ? typeof v !== 'boolean' : !Number.isInteger(v) || v < f.min || v > f.max) throw new Error(`${f.label}超出允许范围。`);
    out[f.key] = v;
  }
  const protectedPaths=input.protectedPaths===undefined?out.protectedPaths:input.protectedPaths;
  if(!Array.isArray(protectedPaths)||protectedPaths.length>200||protectedPaths.some(v=>typeof v!=='string'||!v.trim()||v.length>2048))throw new Error('清理保护路径无效。');
  out.protectedPaths=[...new Set(protectedPaths.map(v=>v.trim()))];
  return out;
}
export const hashText = text => createHash('sha256').update(text).digest('hex');
export function readDocument(file, fallback) {
  try { const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); return { value: JSON.parse(text), hash: hashText(text), exists: true }; }
  catch (e) { if (e.code === 'ENOENT') return { value: structuredClone(fallback), hash: 'missing', exists: false }; throw new Error(`无法读取配置文件：${path.basename(file)}（${e instanceof SyntaxError ? '格式错误' : e.code || '读取失败'}）`); }
}
export function readSettings(root) { const doc = readDocument(path.join(root, 'config', 'operator.json'), DEFAULT_SETTINGS); return { ...doc, value: validateSettings(doc.value) }; }
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, data, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
export function saveDocument(root, file, value, expectedHash, validator) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.operator-write.lock'; let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') { const x = new Error('另一项设置保存仍在进行，请稍后重试。'); x.code = 'CONFLICT'; throw x; } throw e; }
  try {
    const current = readDocument(file, {});
    if (typeof expectedHash !== 'string' || current.hash !== expectedHash) { const e = new Error('设置已被另一个窗口或进程修改，请重新加载后再保存。'); e.code = 'CONFLICT'; throw e; }
    const validated = validator(value);
    if ('revision' in validated) validated.revision = (Number(current.value.revision) || 0) + 1;
    const basename = path.basename(file);
    if (current.exists) {
      const backupDir = path.join(root, 'state', 'operator', 'backups');
      atomicWrite(path.join(backupDir, `${Date.now()}-${randomUUID()}-${basename}`), JSON.stringify(current.value, null, 2) + '\n');
      const old = fs.readdirSync(backupDir).filter(n => n.endsWith('-' + basename)).sort().slice(0, -100);
      for (const name of old) fs.unlinkSync(path.join(backupDir, name));
    }
    if (readDocument(file, {}).hash !== current.hash) { const e = new Error('设置在保存前发生变化，请重新加载。'); e.code = 'CONFLICT'; throw e; }
    atomicWrite(file, JSON.stringify(validated, null, 2) + '\n');
    return readDocument(file, validated);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function controlEndpoint(root, port = 7690) {
  const id = hashText(path.resolve(root).toLowerCase()).slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\spike-bridge-operator-${id}-${port}` : path.join(root, 'state', 'operator', `control-${port}.sock`);
}
export function redact(value) {
  if (typeof value === 'string') return value.replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, '[已隐藏]')
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[=:]\s*)[^\s,"'<>]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]+/gi, '$1?[参数已隐藏]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(token|password|secret|authorization|api[_-]?key|refresh[_-]?token|access[_-]?token)$/i.test(k) ? '[已隐藏]' : redact(v)]));
  return value;
}
