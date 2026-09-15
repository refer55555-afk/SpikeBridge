import json, os, subprocess, sys, tempfile, importlib.util
from pathlib import Path
p = Path(__file__).with_name('mac-worker-b-daemon.py')
spec = importlib.util.spec_from_file_location('mac_worker_b_daemon', p)
daemon = importlib.util.module_from_spec(spec); spec.loader.exec_module(daemon)
usage_lines = b'not json\n{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":12,"output_tokens":4,"reasoning_output_tokens":2}}\n{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1,"total_tokens":8}}\n'
assert daemon.aggregate_usage(usage_lines) == {'inputTokens':15,'cachedInputTokens':12,'outputTokens':7,'reasoningOutputTokens':3,'totalTokens':22}
assert daemon.aggregate_usage(b'{"type":"turn.started"}\nnot json\n') is None
base = {'taskId':'fixture-resume','task':'x','targetCwd':str(Path.cwd()),'model':'gpt-5.6-luna','sandbox':'workspace-write','resumeSessionId':'sess-1'}
assert daemon.build_codex_argv('codex', base, Path('/tmp/last'))[:4] == ['codex','exec','resume','sess-1']
assert daemon.build_codex_argv('codex', {**base,'resumeSessionId':None}, Path('/tmp/last'))[:3] == ['codex','exec','--json']
assert daemon.Worker._is_matching_thread_started('{"type":"thread.started","thread_id":"sess-1"}', 'sess-1')
assert not daemon.Worker._is_matching_thread_started('{"type":"thread.started","thread_id":"other"}', 'sess-1')
body = ('多行 Unicode quote " \'\\\n' * 4096) + '终点'
task = {'taskId':'fixture-python-large','task':body,'targetCwd':str(Path.cwd()),'model':'gpt-5.6-luna','sandbox':'workspace-write'}
with tempfile.TemporaryDirectory(prefix='spike-worker-fixture-') as state:
    env = dict(os.environ, SPIKE_WORKER_B_STATE_ROOT=state)
    r = subprocess.run([sys.executable, str(p), '--fixture'], input=json.dumps(task, ensure_ascii=False), text=True, capture_output=True, check=True, env=env)
out = json.loads(r.stdout)
assert out['testMode'] and out['taskBytes'] == len(body.encode()) and out['taskSha256']
assert len(body.encode()) > 20 * 1024
print('PASS Python fixture validation/lifecycle and >20KB UTF-8 stdin round-trip (no model invocation)')
