'use strict';

// A tiny CommonJS bundler for this repo's own code: follows relative require()
// calls from an entry file and returns one JavaScript expression that evaluates
// to the entry module's exports. Any other require (Node built-ins, npm
// packages) is passed to `externalRequire(spec)`, a function in scope where
// the expression is placed.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function bundle(entry, externalRequire = 'function () { return {}; }') {
  const modules = new Map();
  const visit = (file) => {
    if (modules.has(file)) return;
    const source = fs.readFileSync(file, 'utf8');
    const deps = {};
    modules.set(file, { source, deps });
    for (const [, spec] of source.matchAll(/require\('([^']+)'\)/g)) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`);
      deps[spec] = path.relative(root, resolved);
      visit(resolved);
    }
  };
  visit(path.join(root, entry));

  const defs = [...modules].map(([file, { source, deps }]) => {
    const id = JSON.stringify(path.relative(root, file));
    return `${id}: [function (module, exports, require) {\n${source}\n}, ${JSON.stringify(deps)}]`;
  });
  return `(function (externalRequire) {
  var defs = {${defs.join(',\n')}};
  var cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = (cache[id] = { exports: {} });
    var def = defs[id];
    def[0](module, module.exports, function (spec) {
      return spec in def[1] ? load(def[1][spec]) : externalRequire(spec);
    });
    return module.exports;
  }
  return load(${JSON.stringify(entry)});
})(${externalRequire})`;
}

module.exports = { bundle };
