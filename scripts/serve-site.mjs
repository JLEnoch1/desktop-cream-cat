#!/usr/bin/env node
// 本地预览下载页: node scripts/serve-site.mjs [port]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleCatSkinApi } from './cat-skin-api.mjs'

const root = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'site')
const port = Number(process.argv[2] || 4321)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (urlPath.startsWith('/api/cat-skin/')) {
      handleCatSkinApi(req, res, urlPath).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, code: 'Internal', message: e.message }))
      })
      return
    }
    let file = path.join(root, urlPath === '/' ? 'index.html' : urlPath)
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 — 安装包还没同步进来,先 npm run build:mac 再 npm run site:sync')
      return
    }
    const stat = fs.statSync(file)
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, '127.0.0.1', () => console.log(`下载页预览: http://127.0.0.1:${port}`))
