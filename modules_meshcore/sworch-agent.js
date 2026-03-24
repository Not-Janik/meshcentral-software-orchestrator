/*
  MeshCore-Helfer für das Plugin.
  Dieses Modul ist bewusst defensiv gehalten, weil je nach Agent-/OS-Build nicht jede Funktion verfügbar ist.
*/
(function () {
  function send(obj) {
    try {
      if (typeof mesh !== 'undefined' && mesh?.SendCommand) {
        mesh.SendCommand(obj);
      }
    } catch (e) { }
  }

  function collectWindowsInventory() {
    var out = [];
    try {
      var shell = require('child_process');
      var cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object {$_.DisplayName} | Select-Object DisplayName,DisplayVersion,Publisher | ConvertTo-Json -Compress"';
      var res = shell.execSync(cmd).toString();
      out = JSON.parse(res);
      if (!Array.isArray(out)) out = [out];
    } catch (e) { }
    return out;
  }

  function collectLinuxInventory() {
    var out = [];
    try {
      var shell = require('child_process');
      var res = shell.execSync('sh -lc "command -v dpkg >/dev/null 2>&1 && dpkg-query -W -f=\'${Package}\\t${Version}\\n\' || rpm -qa"').toString();
      out = res.split(/\r?\n/).filter(Boolean).map(function (line) {
        var parts = line.split(/\t/, 2);
        return { name: parts[0], version: parts[1] || '' };
      });
    } catch (e) { }
    return out;
  }

  function collectInventory(platform) {
    platform = String(platform || process.platform || '').toLowerCase();
    if (platform.indexOf('win') >= 0) return collectWindowsInventory();
    return collectLinuxInventory();
  }

  function runScript(msg) {
    var cp = require('child_process');
    var result = { runId: msg.runId, status: 'failed', stdout: '', stderr: '', exitCode: -1 };
    try {
      var type = String(msg.scriptType || 'shell').toLowerCase();
      var body = String(msg.scriptBody || '');
      if (type === 'powershell') {
        var ps = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', body], { encoding: 'utf8' });
        result.stdout = ps.stdout || '';
        result.stderr = ps.stderr || '';
        result.exitCode = Number(ps.status || 0);
      } else {
        var sh = cp.spawnSync(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', body] : ['-lc', body], { encoding: 'utf8' });
        result.stdout = sh.stdout || '';
        result.stderr = sh.stderr || '';
        result.exitCode = Number(sh.status || 0);
      }
      result.status = result.exitCode === 0 ? 'success' : 'failed';
      result.finishedAt = new Date().toISOString();
    } catch (e) {
      result.lastError = String(e && e.message || e);
    }
    send({
      action: 'plugin',
      plugin: 'sworch',
      subaction: 'run-result',
      response: result
    });
  }

  module.exports = {
    sworchHandle: function (msg) {
      if (!msg || msg.plugin !== 'sworch') return false;
      if (msg.subaction === 'collect-inventory') {
        send({
          action: 'plugin',
          plugin: 'sworch',
          subaction: 'inventory-result',
          response: {
            nodeid: msg.nodeid,
            platform: process.platform,
            packages: collectInventory(process.platform)
          }
        });
        return true;
      }
      if (msg.subaction === 'run-script') {
        runScript(msg);
        return true;
      }
      return false;
    }
  };
})();
