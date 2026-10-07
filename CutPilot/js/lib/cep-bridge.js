/*
 * Pulse — minimal CEP bridge.
 * A small functional subset of Adobe's CSInterface.js: evalScript with
 * Promise + JSON handling, and extension path lookup. If you prefer the
 * full official library, drop Adobe's CSInterface.js in this folder and
 * load it before this file — this bridge will defer to it.
 */
(function (root) {
  'use strict';

  function rawEval(script, cb) {
    if (root.CSInterface && root.__cs_instance) {
      root.__cs_instance.evalScript(script, cb);
    } else if (root.__adobe_cep__) {
      root.__adobe_cep__.evalScript(script, cb);
    } else {
      cb('EvalScript error: not running inside CEP.');
    }
  }

  /*
   * Pulse's Premiere script (jsx/host.jsx) is loaded by Premiere from the
   * manifest. When a call comes back as "EvalScript error." the script may
   * never have loaded — every call then fails, which is what the owner's Mac
   * showed ("ExtendScript error while calling CP_getEnv"), with no way to
   * tell why. So once, the bridge asks ExtendScript itself: if CP_getEnv is
   * missing it loads host.jsx with $.evalFile and retries the call; if that
   * load throws, ExtendScript's own message and line number are kept
   * (hostState, shown in 📋 diagnostics and in the error). A function that is
   * there but throws past its own try/catch is called again inside a
   * try/catch, so its message is kept too.
   *   hostState: { state: 'unknown' | 'ok' | 'loaded' | 'failed', detail }
   */
  var hostState = { state: 'unknown', detail: '' };
  var healing = null;
  function hostPath() {
    var p = getExtensionPath();
    return p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '') + '/jsx/host.jsx' : '';
  }
  function ensureHost() {
    if (hostState.state === 'loaded' || hostState.state === 'failed') return Promise.resolve(hostState);
    if (healing) return healing;
    var path = hostPath();
    var check = '(function () { try { if (typeof CP_getEnv === "function") return "PRESENT";' +
      (path ? ' $.evalFile(new File(' + JSON.stringify(path) + '));' : '') +
      ' return (typeof CP_getEnv === "function") ? "LOADED" : "MISSING"; }' +
      ' catch (e) { return "LOADERR " + (e && e.message ? e.message : e) + (e && e.line ? " (line " + e.line + ")" : ""); } })()';
    healing = new Promise(function (resolve) {
      rawEval(check, function (r) {
        r = String(r);
        if (r === 'PRESENT') hostState = { state: 'ok', detail: '' };
        else if (r === 'LOADED') hostState = { state: 'loaded', detail: 'Premiere had not loaded Pulse’s script; Pulse loaded it itself.' };
        else if (/^LOADERR /.test(r)) hostState = { state: 'failed', detail: r.slice(8) };
        else if (r === 'MISSING') hostState = { state: 'failed', detail: 'the script ran but its functions are missing' + (path ? '' : ' (no extension path)') };
        else hostState = { state: 'failed', detail: 'ExtendScript did not answer (' + r.slice(0, 80) + ')' };
        healing = null;
        resolve(hostState);
      });
    });
    return healing;
  }
  function settle(fnName, result, resolve, reject) {
    var parsed;
    try {
      parsed = JSON.parse(result);
    } catch (e) {
      return reject(new Error(fnName + ' returned unparseable result: ' + String(result).slice(0, 200)));
    }
    if (parsed && parsed.ok === false) {
      var err = new Error(parsed.error || ('Host error in ' + fnName));
      err.host = parsed;            // what the host still reports with a failure
      reject(err);
    }
    else resolve(parsed);
  }

  /*
   * Call an ExtendScript function with JSON-safe arguments.
   * Host functions return JSON strings shaped {ok:true,...} or
   * {ok:false,error:"..."}; this resolves/rejects accordingly.
   */
  function callHost(fnName /*, ...args */) {
    var args = Array.prototype.slice.call(arguments, 1).map(function (a) {
      return JSON.stringify(JSON.stringify(a)); // double-encode: ExtendScript receives a JSON string literal
    });
    var script = fnName + '(' + args.join(',') + ')';
    return new Promise(function (resolve, reject) {
      rawEval(script, function (result) {
        if (result !== 'EvalScript error.') return settle(fnName, result, resolve, reject);
        ensureHost().then(function (hs) {
          if (hs.state === 'failed') {
            var ef = new Error('Pulse’s Premiere script didn’t load: ' + hs.detail +
              '. Restart Premiere; if this stays, tap 📋 Copy diagnostics in Settings and send it to aiFloh.');
            ef.hostState = hs;
            return reject(ef);
          }
          // loaded now, or there all along: call again, catching what it throws
          var guarded = '(function () { try { return ' + script + '; } catch (e) { return "CALLERR " + ' +
            '(e && e.message ? e.message : e) + (e && e.line ? " (line " + e.line + ")" : ""); } })()';
          rawEval(guarded, function (r2) {
            if (r2 === 'EvalScript error.' || /^CALLERR /.test(String(r2))) {
              return reject(new Error('Premiere stopped while running ' + fnName +
                (/^CALLERR /.test(String(r2)) ? ': ' + String(r2).slice(8) : ' (no message)') + '.'));
            }
            settle(fnName, r2, resolve, reject);
          });
        });
      });
    });
  }

  function getExtensionPath() {
    if (root.__adobe_cep__ && root.__adobe_cep__.getSystemPath) {
      var p = root.__adobe_cep__.getSystemPath('extension');
      // getSystemPath returns a FILE URL (e.g. file:///Users/.../Pulse on Mac,
      // file:///C:/Users/.../Pulse on Windows). Node's fs can't use that — it
      // needs a plain path. Strip the scheme (and the spurious leading slash before
      // a Windows drive letter), and URL-decode (spaces arrive as %20). Without this
      // every fs lookup under the extension fails, so no bundled .mogrt ever loads.
      try { p = decodeURIComponent(p); } catch (e) {}
      if (/^file:\/\//i.test(p)) {
        p = p.replace(/^file:\/\//i, '');          // file:///Users/... → /Users/... ; file:///C:/... → /C:/...
        if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);   // Windows: /C:/... → C:/...
      }
      return p;
    }
    return '';
  }

  root.CPBridge = {
    callHost: callHost,
    rawEval: rawEval,
    getExtensionPath: getExtensionPath,
    ensureHost: ensureHost,
    hostState: function () { return { state: hostState.state, detail: hostState.detail }; },
    isCEP: function () { return !!root.__adobe_cep__; }
  };
})(typeof self !== 'undefined' ? self : this);
