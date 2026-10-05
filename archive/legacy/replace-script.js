const fs = require('fs');

let content = fs.readFileSync('v12-factory.js', 'utf8');

const startIndex = content.indexOf('// Tier 3.5: AI-Generated Images');
const endIndex = content.indexOf('const allRemoteTiersLookOffline =');

if (startIndex !== -1 && endIndex !== -1) {
  const newText = `// Tier 3.5: Dynamic Motion Graphics (Replaces unstable AI Image APIs)
  recoveryLog.push(\`Scene \${sceneIndex + 1}: Tier 3.5 (Motion Graphics) triggered. Bypassing unstable AI image APIs.\`);
  return {
    kind: 'motion_graphics',
    src: null,
    remoteUrl: null,
    tier: 'Tier 3.5 (Motion Graphics)',
  };

  `;
  
  content = content.substring(0, startIndex) + newText + content.substring(endIndex);
  fs.writeFileSync('v12-factory.js', content, 'utf8');
  console.log('Successfully replaced block in v12-factory.js');
} else {
  console.log('Could not find start or end index');
}
