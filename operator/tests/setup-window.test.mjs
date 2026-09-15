import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=fs.readFileSync(path.join(root,'operator/scripts/SetupWindow.cs'),'utf8');
const build=fs.readFileSync(path.join(root,'operator/scripts/Build-SetupWindow.ps1'),'utf8');
const executable=path.join(root,'operator/Bridge 安装助手.exe');

test('helper has no startup side effect and exposes only fixed human actions',()=>{
  assert.match(source,/Application\.Run\(new SetupWindow\(\)\)/);
  assert.doesNotMatch(source,/Main[\s\S]{0,300}Process\.Start/);
  assert.match(source,/installButton\.Click \+= InstallButtonClick/);
  assert.match(source,/helpButton\.Click \+= HelpButtonClick/);
  assert.match(source,/closeButton\.Click/);
  assert.doesNotMatch(source,/TextBox|OpenFileDialog|SaveFileDialog/);
});

test('installation command is fixed, elevated only for its child, and awaits exit',()=>{
  assert.match(source,/Path\.Combine\(operatorFolder, "scripts", "system\.ps1"\)/);
  assert.match(source,/Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \\"" \+ script \+ "\\" -Action startupEnable"/);
  assert.match(source,/UseShellExecute = true/);
  assert.match(source,/Verb = "runas"/);
  assert.match(source,/await Task\.Run\(\(Action\)process\.WaitForExit\)/);
  assert.match(source,/process\.ExitCode != 0/);
  assert.doesNotMatch(source,/requestedExecutionLevel|requireAdministrator|highestAvailable/);
});

test('cancellation, failure, success, and browser limitation are explicit',()=>{
  assert.match(source,/NativeErrorCode == 1223/);
  assert.match(source,/取消了 Windows 管理员确认，未执行安装/);
  assert.match(source,/安装脚本执行失败，退出代码/);
  assert.match(source,/请返回面板重新检查任务状态/);
  assert.match(source,/Bridge 面板不会关闭或绕过 Codex Browser 沙箱/);
  assert.match(source,/只有明确的官方修复动作才应请求管理员权限/);
});

test('source and build contain no alternate task or sandbox mutation command',()=>{
  for(const text of [source,build]) {
    assert.doesNotMatch(text,/schtasks|Register-ScheduledTask|Set-Acl|icacls|takeown|startupDisable|channelStart|channelStop|channelRestart/i);
  }
  assert.match(build,/\/target:winexe/);
  assert.match(build,/Bridge 安装助手\.exe/);
});

test('compiled helper is a Windows PE executable without launching it',()=>{
  const data=fs.readFileSync(executable);
  assert.ok(data.length>4096);
  assert.equal(data.subarray(0,2).toString('ascii'),'MZ');
  const peOffset=data.readUInt32LE(0x3c);
  assert.equal(data.subarray(peOffset,peOffset+4).toString('binary'),'PE\u0000\u0000');
});
