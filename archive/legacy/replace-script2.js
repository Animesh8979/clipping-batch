const fs = require('fs');
let content = fs.readFileSync('v12-factory.js', 'utf8');

content = content.replace(
  /\`npx remotion render src\/index\.jsx \$\{v15Id\} "\$\{outputPath\}" --props="\$\{propsPath\}"\`/g,
  `\`npx remotion render src/index.jsx \${v15Id} "\${outputPath}" --props="\${propsPath}" --concurrency=1 --gl=swiftshader\``
);

fs.writeFileSync('v12-factory.js', content, 'utf8');
console.log('Fixed swiftshader rendering');
