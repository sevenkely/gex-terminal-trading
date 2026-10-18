/* Browser bootstrap for isolated, explicitly synthetic UI acceptance tests. */
const {chromium: pw} = require('../.cache/ui/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const {execFileSync} = require('node:child_process');

exports.launchBrowser=async()=>{
 const {default: chromium} = await import('../.cache/ui/node_modules/@sparticuz/chromium/build/index.js');
 const cache = path.resolve(__dirname, '../.cache/ui');
 const lib = path.join(cache, 'al2023/lib');
 if (!fs.existsSync(path.join(lib, 'libnss3.so'))) {
   fs.mkdirSync(path.join(cache, 'al2023'), {recursive:true});
   const tar = path.join(cache, 'al2023.tar');
   fs.writeFileSync(tar, zlib.brotliDecompressSync(fs.readFileSync(path.join(cache, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br'))));
   execFileSync('tar', ['xf', tar, '-C', path.join(cache,'al2023')]);
 }
 const browser=await pw.launch({args:chromium.args, executablePath:await chromium.executablePath(),headless:true,
   env:{...process.env, LD_LIBRARY_PATH:[lib,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
 return browser;
};

exports.waitForFixture=async base=>{const {expect}=require('../.cache/ui/node_modules/playwright/test');await expect.poll(async()=>{try{return (await fetch(new URL('/api/health',base))).status}catch{return 0}},{timeout:20000,message:'Isolated UI fixture must become ready'}).toBe(200)};
