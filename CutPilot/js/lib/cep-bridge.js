/*
 * CutPilot — minimal CEP bridge.
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
        if (result === 'EvalScript error.') {
          return reject(new Error('ExtendScript error while calling ' + fnName + ' (check the host script loaded).'));
        }
        var parsed;
        try {
          parsed = JSON.parse(result);
        } catch (e) {
          return reject(new Error(fnName + ' returned unparseable result: ' + String(result).slice(0, 200)));
        }
        if (parsed && parsed.ok === false) reject(new Error(parsed.error || ('Host error in ' + fnName)));
        else resolve(parsed);
      });
    });
  }

  function getExtensionPath() {
    if (root.__adobe_cep__ && root.__adobe_cep__.getSystemPath) {
      return root.__adobe_cep__.getSystemPath('extension');
    }
    return '';
  }

  root.CPBridge = {
    callHost: callHost,
    rawEval: rawEval,
    getExtensionPath: getExtensionPath,
    isCEP: function () { return !!root.__adobe_cep__; }
  };
})(typeof self !== 'undefined' ? self : this);
