const Module = require('module');
const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const result = origLoad.apply(this, arguments);
  if (request.includes('next/dist/server/lib/utils') || (request.includes('utils') && parent && parent.filename && parent.filename.includes('next-build'))) {
    if (result && result.printAndExit) {
      const origPrint = result.printAndExit;
      result.printAndExit = function(msg, code) {
        if (msg && msg.stack) {
          process.stderr.write('FULL STACK:\n' + msg.stack + '\n');
        }
        return origPrint(msg, code);
      };
    }
  }
  return result;
};
