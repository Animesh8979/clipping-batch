const fs = require('fs');
let pkg = fs.readFileSync('package.json', 'utf8');
pkg = pkg.replace(/--gap-minutes 60/g, '--gap-minutes 180');
fs.writeFileSync('package.json', pkg, 'utf8');
console.log('Fixed package.json');
