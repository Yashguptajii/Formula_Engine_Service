const path = require('node:path');
global.require = require;
// The interpreter also evaluates generated code that references __dirname.
if (process.argv[1]) global.__dirname = path.dirname(process.argv[1]);
