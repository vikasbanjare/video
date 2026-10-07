/*
 * es3-runtime.js — run jsx/host.jsx in a vm whose built-ins look like
 * Premiere's ExtendScript (ECMAScript 3), not like Node's.
 *
 * Every host gate runs the real host.jsx in a Node vm. Node's built-ins are
 * ES2023: Array.prototype.indexOf, String.prototype.trim, Object.keys,
 * Date.now, Function.prototype.bind and JSON all exist there — and none of
 * them exist in ExtendScript. A host function using one passes every gate and
 * stops with "… is not a function" on the owner's Mac. So the loaders call
 * strip(context) before host.jsx runs: the vm's OWN intrinsics lose every
 * method ES3 does not have, and JSON is removed so host.jsx's own JSON
 * polyfill is what every gate exercises (ExtendScript has no JSON object).
 *
 * Only the vm's intrinsics are touched — never Node's (a sandbox that hands
 * Node's own Array/Object/Date/… in as globals is refused: stripping those
 * would break Node itself, and leaving them would hide ES5 calls).
 * PULSE_HOST_RUNTIME=node turns this off (to tell a runtime gap from a bug).
 */
'use strict';
const vm = require('vm');

const ARRAY = ['indexOf', 'lastIndexOf', 'forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'includes', 'fill', 'keys', 'values', 'entries', 'flat', 'flatMap', 'copyWithin', 'at',
  'toReversed', 'toSorted', 'toSpliced', 'with'];
const STRING = ['trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight', 'includes', 'startsWith', 'endsWith', 'repeat',
  'padStart', 'padEnd', 'codePointAt', 'normalize', 'at', 'replaceAll', 'matchAll'];
const OBJECT = ['keys', 'create', 'defineProperty', 'defineProperties', 'getOwnPropertyNames', 'getOwnPropertyDescriptor',
  'getPrototypeOf', 'freeze', 'seal', 'isFrozen', 'isSealed', 'preventExtensions', 'isExtensible', 'assign', 'entries',
  'values', 'fromEntries', 'is', 'setPrototypeOf'];

/* What the sandbox must not shadow with Node's own objects. */
const OWN = ['Array', 'Object', 'String', 'Date', 'Function', 'Number', 'RegExp', 'Math', 'JSON', 'Error'];

function strip(context) {
  if (process.env.PULSE_HOST_RUNTIME === 'node') return context;
  const shadowed = OWN.filter(n => Object.prototype.hasOwnProperty.call(context, n) && context[n] === global[n]);
  if (shadowed.length) {
    throw new Error('es3-runtime: the sandbox hands Node’s own ' + shadowed.join(', ') +
      ' to host.jsx — leave them out (the vm has its own) so ExtendScript’s missing methods can be removed');
  }
  vm.runInContext('(function (A, S, O) {' +
    ' var AP = [].constructor.prototype, SP = "".constructor.prototype, OC = ({}).constructor;' +
    ' var i; for (i = 0; i < A.length; i++) delete AP[A[i]];' +
    ' for (i = 0; i < S.length; i++) delete SP[S[i]];' +
    ' for (i = 0; i < O.length; i++) delete OC[O[i]];' +
    ' var AC = [].constructor; delete AC.isArray; delete AC.from; delete AC.of;' +
    ' delete (function () {}).constructor.prototype.bind;' +
    ' var D = (0, eval)("Date"); delete D.now; delete D.prototype.toISOString; delete D.prototype.toJSON;' +
    ' var N = (0).constructor; delete N.isInteger; delete N.isFinite; delete N.isNaN; delete N.parseFloat; delete N.parseInt; delete N.isSafeInteger;' +
    ' var M = (0, eval)("Math"); delete M.trunc; delete M.sign; delete M.log10; delete M.log2; delete M.hypot; delete M.cbrt; delete M.fround; delete M.clz32; delete M.imul;' +
    '})(' + JSON.stringify(ARRAY) + ',' + JSON.stringify(STRING) + ',' + JSON.stringify(OBJECT) + ');' +
    'delete this.JSON;', context);
  return context;
}

/* the sandbox's own Object.prototype.hasOwnProperty etc. stay: they are ES3 */
module.exports = { strip, ARRAY, STRING, OBJECT };
