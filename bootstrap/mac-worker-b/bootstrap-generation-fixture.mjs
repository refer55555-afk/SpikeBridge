import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(.)\:/, '$1:');
const template = fs.readFileSync(path.join(dir, 'mac-worker-b-bootstrap.sh'), 'utf8');
const dummy = Buffer.from('#!/usr/bin/env python3\nprint("fixture")\n', 'utf8').toString('base64');
const rendered = template.replaceAll('__BRIDGE_URL__', 'http://192.168.5.13:60766').replaceAll('__PAIRING_SECRET__', 'dummy-secret').replaceAll('__MAC_PORT__', '8767').replace('__DAEMON_B64__', dummy);
for (const placeholder of ['__BRIDGE_URL__', '__PAIRING_SECRET__', '__MAC_PORT__', '__DAEMON_B64__']) assert.doesNotMatch(rendered, new RegExp(placeholder));
assert.match(rendered, /<<'SPIKE_WORKER_B64_END'/);
assert.match(rendered, /base64\.b64decode\(sys\.stdin\.buffer\.read\(\), validate=True\)/);
assert.match(rendered, /\$PYTHON3.*-c 'import base64,sys/);
assert.match(rendered, /py_compile/);
assert.match(rendered, /mv -f "\$WORKER_TMP" "\$WORKER"/);
assert.doesNotMatch(rendered, /base64\s+-D/);
console.log('PASS model-free bootstrap generation fixture');
