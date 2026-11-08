const { copyFileSync } = require('node:fs');
const path = require('node:path');

const output = path.join(__dirname, 'dist');
for (const name of ['index.html', 'style.css', 'items.svg', 'mark.svg', 'hero.mp4', 'hero-poster.jpg']) {
  copyFileSync(path.join(__dirname, 'public', name), path.join(output, name));
}
for (const [source, target] of [['BananaSMP_Icon.png', 'logo.png'], ['BananaSMP_Banner.png', 'banner.png']]) {
  copyFileSync(path.join(__dirname, '..', 'assets', source), path.join(output, target));
}
