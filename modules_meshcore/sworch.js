(function () {
  function send(obj) {
    try {
      if (typeof mesh !== 'undefined' && mesh && typeof mesh.SendCommand === 'function') {
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
          var p = line.split(/\t/, 2);
          return { name: p[0] || line, version: p[1] || '', publisher: '' };
        });
      }
    } catch (e) { }
    return out;
  }

  function runScript(msg) {
    var cp = require('child_process');
    var result = { runId: msg.runId, status: 'failed', stdout: '', stderr: '', exitCode: -1 };
    try {
      var type = String(msg.scriptType || 'shell').toLowerCase();
      var body = String(msg.scriptBody || '');
      var proc;
      if (type === 'powershell') {
        proc = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', body], { encoding: 'utf8' });
      } else if (process.platform === 'win32') {
        proc = cp.spawnSync('cmd.exe', ['/c', body], { encoding: 'utf8' });
      } else {
        proc = cp.spawnSync('/bin/sh', ['-lc', body], { encoding: 'utf8' });
      }
      result.stdout = proc.stdout || '';
      result.stderr = proc.stderr || '';
      result.exitCode = (proc.status == null) ? 1 : Number(proc.status);
      result.status = result.exitCode === 0 ? 'success' : 'failed';
    } catch (e) {
      result.stderr = String((e && e.message) || e);
      result.exitCode = 1;
    }
    send({ action: 'plugin', plugin: 'sworch', subaction: 'run-result', response: result });
  }

  module.exports = {
    sworchHandle: function (msg) {
      if (!msg || msg.plugin !== 'sworch') return false;
      if (msg.subaction === 'collect-inventory') {
        send({ action: 'plugin', plugin: 'sworch', subaction: 'inventory-result', response: { nodeid: msg.nodeid, platform: process.platform, packages: collectInventory() } });
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
