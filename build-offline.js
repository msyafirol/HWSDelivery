'use strict';
// Builds dist/hwotg-offline.html: the web app as one self-contained file that runs without a server or internet.
// It inlines the fonts, the Excel/PDF export libraries and the in-browser backend (offline/local-backend.js).
const fs = require('node:fs'), path = require('node:path');
const R = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const V = 'offline/vendor/';
const js = s => s.replace(/<\/script/gi, '<\\/script');
let html = R('public/index.html');
const fonts = R(V + 'fonts.css').replace(/url\((font\d+\.woff2)\)/g, (m, f) => 'url(data:font/woff2;base64,' + fs.readFileSync(path.join(__dirname, V, f)).toString('base64') + ')');
const link = /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/;
if (!link.test(html)) throw new Error('Font link not found in public/index.html');
html = html.replace(link, () => '<style>' + fonts + '</style>');
const libs = ['xlsx.full.min.js', 'jspdf.umd.min.js', 'jspdf.plugin.autotable.min.js'].map(f => '<script>' + js(R(V + f)) + '</script>').join('\n');
const anchor = '<div id="app"></div>';
if (!html.includes(anchor)) throw new Error('App anchor not found');
html = html.replace(anchor, () => libs + '\n<script>' + js(R('offline/local-backend.js')) + '</script>\n' + anchor);
html = html.replace('<title>HWOTG Delivery Tracking</title>', '<title>HWOTG Delivery Tracking (offline)</title>');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/hwotg-offline.html'), html);
console.log('dist/hwotg-offline.html', (html.length / 1048576).toFixed(2) + ' MB');
