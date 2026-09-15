#!/usr/bin/env python3
"""Mac Worker B daemon. Python 3.9 standard library only."""
import hashlib, json, os, re, subprocess, sys, threading, time, urllib.request, urllib.error
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_MODEL = 'gpt-5.6-luna'; MAX_BODY = 128 * 1024; MAX_TASK = 128 * 1024
MAX_STDERR = 8192; MAX_LAST = 16384; SANDBOXES = {'read-only', 'workspace-write'}
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
CAPABILITIES = ['health', 'submit', 'status-result']
def now(): return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
def bounded(v, n): return str(v or '')[:n]
def chmod600(p):
    try: os.chmod(p, 0o600)
    except OSError: pass
def chmod700(p):
    try: os.chmod(p, 0o700)
    except OSError: pass
def write_json(p, value):
    p.parent.mkdir(parents=True, exist_ok=True); tmp = p.with_name('.' + p.name + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f: json.dump(value, f, ensure_ascii=False, indent=2); f.write('\n')
    chmod600(tmp); os.replace(tmp, p); chmod600(p)
def read_json(p):
    with open(p, encoding='utf-8') as f: return json.load(f)
def collect_ids(v, out=None):
    out = [] if out is None else out
    if isinstance(v, dict):
        for k, x in v.items():
            if k in ('thread_id','threadId','session_id','sessionId') and isinstance(x, str) and x and x not in out: out.append(x)
            collect_ids(x, out)
    elif isinstance(v, list):
        for x in v: collect_ids(x, out)
    return out
def _nonnegative_int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None
def parse_usage_line(event):
    if not isinstance(event, dict) or event.get('type') != 'turn.completed': return None
    usage = event.get('usage')
    if not isinstance(usage, dict): return None
    fields = {k: _nonnegative_int(usage.get(k)) for k in ('input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens')}
    if not any(v is not None for v in fields.values()): return None
    input_tokens = fields['input_tokens'] or 0; cached = min(fields['cached_input_tokens'] or 0, input_tokens)
    output = fields['output_tokens'] or 0; reasoning = fields['reasoning_output_tokens'] or 0
    explicit_total = fields['total_tokens']
    trustworthy_total = explicit_total if explicit_total is not None and explicit_total >= input_tokens + output else None
    return {'inputTokens': input_tokens, 'cachedInputTokens': cached, 'outputTokens': output, 'reasoningOutputTokens': reasoning, '_explicitTotal': trustworthy_total}
def aggregate_usage(raw):
    total = {'inputTokens': 0, 'cachedInputTokens': 0, 'outputTokens': 0, 'reasoningOutputTokens': 0}; explicit = 0; saw = False; all_explicit = True
    lines = raw.decode('utf-8','replace').splitlines() if isinstance(raw, (bytes, bytearray)) else str(raw).splitlines()
    for line in lines:
        try: item = parse_usage_line(json.loads(line))
        except (ValueError, TypeError): item = None
        if item is None: continue
        saw = True
        for key in total: total[key] += item[key]
        if item['_explicitTotal'] is None: all_explicit = False
        else: explicit += item['_explicitTotal']
    if not saw: return None
    total['cachedInputTokens'] = min(total['cachedInputTokens'], total['inputTokens'])
    total['totalTokens'] = explicit if all_explicit else total['inputTokens'] + total['outputTokens']
    return total
def build_codex_argv(codex, task, lastpath):
    common = [codex, 'exec', '--json', '--skip-git-repo-check', '--output-last-message', str(lastpath), '--model', task['model']]
    if task.get('resumeSessionId'):
        return common + ['resume', task['resumeSessionId'], '-']
    return common + ['--sandbox', task['sandbox'], '--cd', task['targetCwd'], '-']

class Worker:
    def __init__(self):
        self.root = Path(os.environ.get('SPIKE_WORKER_B_STATE_ROOT', str(Path.home() / 'Library/Application Support/SpikeWorkerB')))
        self.state = self.root / 'state'; self.state.mkdir(parents=True, exist_ok=True); chmod700(self.state)
        self.secret = os.environ.get('SPIKE_WORKER_B_PAIRING_SECRET', ''); self.bridge = os.environ.get('SPIKE_WORKER_B_BRIDGE_URL', '')
        self.codex = os.environ.get('SPIKE_WORKER_B_CODEX', 'codex'); self.port = int(os.environ.get('SPIKE_WORKER_B_PORT', '8767'))
        self.direct_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.lock = threading.Lock(); self.active = None
    def validate(self, x):
        if not isinstance(x, dict): raise ValueError('JSON object required')
        tid, body = x.get('taskId'), x.get('task')
        if not isinstance(tid, str) or not ID_RE.fullmatch(tid): raise ValueError('invalid taskId')
        if not isinstance(body, str) or not body or len(body.encode('utf-8')) > MAX_TASK: raise ValueError('task body invalid or too large')
        model = x.get('model', DEFAULT_MODEL); allow = x.get('allowAstra') is True
        if not isinstance(model, str) or not 0 < len(model.strip()) < 128 or ('astra' in model.lower() and not allow): raise ValueError('model policy rejected')
        sandbox = x.get('sandbox', 'workspace-write')
        if sandbox not in SANDBOXES: raise ValueError('sandbox invalid')
        cwd = x.get('targetCwd')
        if not isinstance(cwd, str) or not os.path.isdir(cwd): raise ValueError('targetCwd invalid')
        resume = x.get('resumeSessionId')
        if resume is not None and (not isinstance(resume, str) or not ID_RE.fullmatch(resume)): raise ValueError('invalid resumeSessionId')
        return {'taskId':tid, 'task':body, 'targetCwd':os.path.realpath(cwd), 'model':model.strip(), 'sandbox':sandbox, 'allowAstra':allow, 'resumeSessionId':resume}
    def paths(self, tid):
        d = self.state / tid; return d, d/'status.json', d/'result.json', d/'events.jsonl', d/'stderr.log', d/'last-message.txt'
    def ack_path(self, tid): return self.paths(tid)[0] / 'ack.json'
    def is_acked(self, tid):
        try: return bool(read_json(self.ack_path(tid)).get('acked'))
        except (OSError, ValueError, AttributeError): return False
    def mark_acked(self, tid): write_json(self.ack_path(tid), {'taskId': tid, 'acked': True, 'ackedAtUtc': now()})
    def result_payload(self, tid):
        try: return read_json(self.paths(tid)[2])
        except (OSError, ValueError): return None
    def post_result(self, result):
        if not self.bridge or not self.secret: return False
        raw = json.dumps(result, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.bridge.rstrip('/') + '/worker/result', data=raw,
            headers={'Authorization':'Bearer '+self.secret, 'Content-Type':'application/json'}, method='POST')
        try:
            with self.direct_http.open(req, timeout=10) as response:
                if 200 <= response.status < 300:
                    self.mark_acked(result['taskId']); return True
        except (OSError, urllib.error.HTTPError): pass
        return False
    def resend_unacked(self):
        for d in self.state.iterdir():
            if not d.is_dir(): continue
            result = d / 'result.json'
            if result.exists() and not self.is_acked(d.name):
                value = self.result_payload(d.name)
                if value: self.post_result(value)
    def pending_ack_count(self):
        count = 0
        try:
            for d in self.state.iterdir():
                if d.is_dir() and (d / 'result.json').exists() and not self.is_acked(d.name): count += 1
        except OSError: pass
        return count
    def reverse_pull(self):
        self.resend_unacked()
        while True:
            if self.active is not None:
                time.sleep(2.5); continue
            self.resend_unacked()
            if not self.bridge or not self.secret:
                time.sleep(2.5); continue
            req = urllib.request.Request(self.bridge.rstrip('/') + '/worker/next', headers={'Authorization':'Bearer '+self.secret}, method='GET')
            try:
                with self.direct_http.open(req, timeout=10) as response:
                    if response.status == 204: task = None
                    elif 200 <= response.status < 300: task = json.loads(response.read().decode('utf-8'))
                    else: task = None
                if task:
                    tid = task.get('taskId')
                    if not isinstance(tid, str) or not ID_RE.fullmatch(tid):
                        time.sleep(2.5); continue
                    if self.result_payload(tid) is not None:
                        self.post_result(self.result_payload(tid))
                    else:
                        try: self.launch(self.validate(task))
                        except (ValueError, TypeError) as exc:
                            self.post_result({'schema':'spike-home.mac-worker-b.result.v1','taskId':tid,'state':'failed','ok':False,'exitCode':1,'error':bounded(exc,MAX_STDERR)})
            except (OSError, urllib.error.HTTPError, ValueError, UnicodeError): pass
            time.sleep(2.5)
    def launch(self, task):
        d, status, result, events, errpath, lastpath = self.paths(task['taskId']); d.mkdir(mode=0o700, parents=True, exist_ok=True)
        running = dict(task, state='running', startedAtUtc=now()); write_json(status, running); self.active = task['taskId']
        if os.environ.get('SPIKE_WORKER_B_FIXTURE') == '1':
            result_data = dict(schema='spike-home.mac-worker-b.result.v1', taskId=task['taskId'], state='completed', ok=True, exitCode=0, model=task['model'], targetCwd=task['targetCwd'], testMode=True, taskBytes=len(task['task'].encode('utf-8')), taskSha256=hashlib.sha256(task['task'].encode('utf-8')).hexdigest(), lastMessage='fixture result', stderr='', sessionIds=[])
            events.write_text('', encoding='utf-8'); errpath.write_text('', encoding='utf-8'); lastpath.write_text('fixture result', encoding='utf-8')
            write_json(result, result_data); write_json(status, dict(running, state='completed', finishedAtUtc=now(), exitCode=0)); self.active = None; return
        threading.Thread(target=self.run_codex, args=(task,status,result,events,errpath,lastpath), daemon=True).start()
    def run_codex(self, task, status, result, events, errpath, lastpath):
        env = dict(os.environ); env.pop('OPENAI_API_KEY', None)
        sqlite_home = self.root / 'codex-sqlite'; sqlite_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        env['CODEX_SQLITE_HOME'] = str(sqlite_home)
        argv = build_codex_argv(self.codex, task, lastpath)
        try:
            p = subprocess.Popen(argv, cwd=task['targetCwd'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out, err = p.communicate(task['task'].encode('utf-8')); events.write_bytes(out)
            stderr = err.decode('utf-8','replace')[-MAX_STDERR:]; errpath.write_text(stderr, encoding='utf-8'); ids=[]
            for line in out.decode('utf-8','replace').splitlines():
                try: collect_ids(json.loads(line), ids)
                except (ValueError, TypeError): pass
            resume_mismatch = bool(task.get('resumeSessionId')) and not any(self._is_matching_thread_started(line, task['resumeSessionId']) for line in out.decode('utf-8','replace').splitlines())
            try: last = lastpath.read_text(encoding='utf-8')[-MAX_LAST:]
            except OSError: last = ''
            state = 'completed' if p.returncode == 0 and not resume_mismatch else 'failed'; data = dict(schema='spike-home.mac-worker-b.result.v1',taskId=task['taskId'],state=state,ok=state=='completed',exitCode=p.returncode,model=task['model'],targetCwd=task['targetCwd'],lastMessage=last,stderr=stderr,sessionIds=ids)
            usage = aggregate_usage(out)
            if usage is not None: data['usage'] = usage
            if task.get('resumeSessionId'):
                data['resumeSessionId'] = task['resumeSessionId']; data['resumeMismatch'] = resume_mismatch
                if resume_mismatch: data['error'] = 'resume thread_id did not match requested resumeSessionId'
            write_json(result, data); write_json(status, dict(task,state=state,finishedAtUtc=now(),exitCode=p.returncode,sessionIds=ids))
        except Exception as exc:
            write_json(result, dict(schema='spike-home.mac-worker-b.result.v1',taskId=task['taskId'],state='failed',ok=False,exitCode=1,error=bounded(exc,MAX_STDERR)))
            write_json(status, dict(task,state='failed',finishedAtUtc=now(),exitCode=1))
        finally: self.active = None
    @staticmethod
    def _is_matching_thread_started(line, requested):
        try:
            event = json.loads(line)
            return isinstance(event, dict) and event.get('type') == 'thread.started' and event.get('thread_id') == requested
        except (ValueError, TypeError): return False
    def facts(self):
        return {'host':bounded(os.uname().nodename,128),'platform':'darwin','arch':bounded(os.uname().machine,32),'servicePort':self.port,'codexVersion':bounded(os.environ.get('SPIKE_WORKER_B_CODEX_VERSION',''),128),'nodeVersion':'','capabilities':CAPABILITIES}
    def register(self):
        if not self.bridge or not self.secret: return
        for endpoint in ('register',):
            req=urllib.request.Request(self.bridge.rstrip('/')+'/'+endpoint,data=json.dumps(self.facts()).encode(),headers={'Authorization':'Bearer '+self.secret,'Content-Type':'application/json'},method='POST')
            try: self.direct_http.open(req, timeout=10).close()
            except OSError: pass
    def heartbeat(self):
        while True:
            time.sleep(30)
            if not self.bridge or not self.secret: continue
            req=urllib.request.Request(self.bridge.rstrip('/')+'/heartbeat',data=json.dumps(self.facts()).encode(),headers={'Authorization':'Bearer '+self.secret,'Content-Type':'application/json'},method='POST')
            try: self.direct_http.open(req, timeout=10).close()
            except OSError: pass

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, code, value):
        raw=json.dumps(value,ensure_ascii=False).encode(); self.send_response(code); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def auth(self): return self.headers.get('Authorization','') == 'Bearer '+self.server.worker.secret
    def do_GET(self):
        if self.path == '/health': return self.reply(200,{'ok':True,'service':'mac-worker-b','busy':self.server.worker.active is not None,'reversePull':True,'pendingAck':self.server.worker.pending_ack_count()})
        if not self.auth(): return self.reply(401,{'error':'unauthorized'})
        if self.path.startswith('/task/'):
            tid=self.path[6:]
            if not ID_RE.fullmatch(tid): return self.reply(400,{'error':'invalid taskId'})
            d,status,result,*_=self.server.worker.paths(tid)
            for p in (result,status):
                if p.exists():
                    try: return self.reply(200,read_json(p))
                    except (OSError,ValueError): return self.reply(500,{'error':'corrupt state'})
            return self.reply(404,{'error':'not found'})
        return self.reply(404,{'error':'not found'})
    def do_POST(self):
        if not self.auth(): return self.reply(401,{'error':'unauthorized'})
        if self.path != '/task': return self.reply(404,{'error':'not found'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length <= 0 or length > MAX_BODY: raise ValueError('body too large')
            task=self.server.worker.validate(json.loads(self.rfile.read(length).decode('utf-8'))); d,*_=self.server.worker.paths(task['taskId'])
            with self.server.worker.lock:
                if self.server.worker.active is not None: return self.reply(409,{'error':'worker busy'})
                if d.exists(): return self.reply(409,{'error':'duplicate taskId'})
                self.server.worker.launch(task)
            return self.reply(202,{'ok':True,'taskId':task['taskId'],'state':'running'})
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc: return self.reply(413 if 'large' in str(exc) else 400,{'error':str(exc)})

def fixture():
    os.environ['SPIKE_WORKER_B_FIXTURE'] = '1'; w=Worker(); task=w.validate(json.load(sys.stdin)); w.launch(task); _,_,result,*_=w.paths(task['taskId']); print(json.dumps(read_json(result),ensure_ascii=False)); return 0
def main():
    if '--fixture' in sys.argv: return fixture()
    w=Worker(); server=ThreadingHTTPServer(('0.0.0.0',w.port),Handler); server.worker=w; w.register(); threading.Thread(target=w.heartbeat,daemon=True).start(); threading.Thread(target=w.reverse_pull,daemon=True).start(); server.serve_forever()
if __name__ == '__main__': sys.exit(main())
