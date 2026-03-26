/**
 * MeshCentral Software Orchestrator agent module
 * ScriptTask-style meshcore entrypoint.
 */
"use strict";
var mesh;
var _sessionid;

function send(obj) {
  try {
    if (mesh && typeof mesh.SendCommand === 'function') {
      mesh.SendCommand(obj);
    }
  } catch (e) { }
}

function collectInventory() {
  var out = [];
  try {
    var cp = require('child_process');
    if (process.platform === 'win32') {
      var ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
        + '$paths=@("HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*");'
        + '$apps=Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName};'
        + '$apps | Select-Object DisplayName,DisplayVersion,Publisher | ConvertTo-Json -Compress';
      var res = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
      var txt = String(res.stdout || '').trim();
      if (txt) {
        out = JSON.parse(txt);
        if (!Array.isArray(out)) out = [out];
        out = out.map(function (x) { return { name: x.DisplayName || '', version: x.DisplayVersion || '', publisher: x.Publisher || '' }; });
      }
    } else {
      var cmd = 'if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f="${binary:Package}\\t${Version}\\n"; elif command -v rpm >/dev/null 2>&1; then rpm -qa; else true; fi';
      var res2 = cp.spawnSync('/bin/sh', ['-lc', cmd], { encoding: 'utf8' });
      var txt2 = String(res2.stdout || '');
      out = txt2.split(/\r?\n/).filter(Boolean).map(function (line) {
        var parts = line.split(/\t/, 2);
        return { name: parts[0] || line, version: parts[1] || '', publisher: '' };
      });
    }
  } catch (e) { }
  return out;
}

function runScript(args) {
  var cp = require('child_process');
  var result = {
    runId: args.runId,
    status: 'failed',
    stdout: '',
    stderr: '',
    exitCode: -1,
    lastError: null
  };
  try {
    var type = String(args.scriptType || 'shell').toLowerCase();
    var body = String(args.scriptBody || '');
    var proc;
    if (type === 'powershell') {
      proc = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', body], { encoding: 'utf8' });
    } else if (process.platform === 'win32') {
      proc = cp.spawnSync('cmd.exe', ['/c', body], { encoding: 'utf8' });
    } else {
      proc = cp.spawnSync('/bin/sh', ['-lc', body], { encoding: 'utf8' });
    }
    result.stdout = proc && proc.stdout ? String(proc.stdout) : '';
    result.stderr = proc && proc.stderr ? String(proc.stderr) : '';
    result.exitCode = (proc && proc.status != null) ? Number(proc.status) : 1;
    result.status = result.exitCode === 0 ? 'success' : 'failed';
  } catch (e) {
    result.stderr = String((e && e.message) || e);
    result.exitCode = 1;
    result.lastError = result.stderr;
  }
  send({ action: 'plugin', plugin: 'sworch', pluginaction: 'run-result', sessionid: _sessionid, response: result, tag: 'console' });
}

function consoleaction(args, rights, sessionid, parent) {
  mesh = parent;
  _sessionid = sessionid;
  if (!args) return;
  var action = args.pluginaction || args.subaction || ((args._ && args._[1]) ? args._[1] : null);
  switch (action) {
    case 'collect-inventory':
      send({ action: 'plugin', plugin: 'sworch', pluginaction: 'inventory-result', sessionid: _sessionid, response: { nodeid: args.nodeid, platform: process.platform, packages: collectInventory() }, tag: 'console' });
      return 'ok';
    case 'run-script':
      runScript(args);
      return 'ok';
    default:
      return;
  }
}


module.exports = { consoleaction: consoleaction };
