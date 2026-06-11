const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, '..', 'dist-electron')
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

// Inject DOMMatrix polyfill at the very top of main.js (before any pdfjs-dist code runs)
const mainJs = path.join(dir, 'main.js')
if (fs.existsSync(mainJs)) {
  const polyfill = `// Polyfill browser APIs for pdfjs-dist in Node.js
const _g = globalThis;
if (!_g.DOMMatrix) { _g.DOMMatrix = class { a=1;b=0;c=0;d=1;e=0;f=0;is2D=true;isIdentity=true; } }
if (!_g.DOMPoint) { _g.DOMPoint = class { x=0;y=0;z=0;w=1; } }
if (!_g.DOMPointReadOnly) { _g.DOMPointReadOnly = _g.DOMPoint; }

`
  let content = fs.readFileSync(mainJs, 'utf8')
  if (!content.startsWith('// Polyfill')) {
    content = polyfill + content
    fs.writeFileSync(mainJs, content)
    console.log('Injected DOMMatrix polyfill into main.js')
  }
}
