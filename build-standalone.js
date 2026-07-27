const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');
const js = ['solar-model.js', 'energy-model.js', 'app.js']
  .map(f => '/* ===== ' + f + ' ===== */\n' + fs.readFileSync(f, 'utf8'))
  .join('\n\n');

html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>\n' + css + '\n</style>');
html = html.replace(
  /<script src="solar-model\.js"><\/script>\s*<script src="energy-model\.js"><\/script>\s*<script src="app\.js"><\/script>/,
  '<script>\n' + js + '\n</script>'
);
html = html.replace('<title>', '<!-- Standalone build: open this file directly in a browser, no web server needed. -->\n<title>');

if (html.includes('href="styles.css"') || html.includes('src="app.js"')) {
  console.error('FAILED: external references remain'); process.exit(1);
}
fs.writeFileSync('solar-predictor-newcastle-west.html', html);
console.log('standalone written:', (html.length / 1024).toFixed(1), 'KB');
