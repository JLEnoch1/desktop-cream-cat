/**
 * AI 毛发定制工坊 · 后端接口（仅随 scripts/serve-site.mjs 本地预览启用）。
 *
 * 职责：
 *  - GET  /api/cat-skin/status   → 服务是否可用（是否配置 DASHSCOPE_API_KEY / mock）
 *  - POST /api/cat-skin/generate → 调百炼「千问-图像编辑」把用户猫照片转成指定姿态的卡通形象
 *
 * 真 AI 路线：DashScope multimodal-generation（qwen-image 系列图像编辑），
 * Base64 图片直传、服务端代下载产物图（结果 URL 只有 24h 有效，且避免浏览器跨域）。
 * 提示词全部收在服务端（POSE_DESC / STYLE），客户端只传 {pose, images}。
 *
 * 角色一致性：客户端按 idle → walk1 → walk2 → sleep → drag → pet → tap 顺序串行生成，
 * 非 idle 姿态会把「已定稿的形象图」作为最后一张参考图传入（qwen 支持 1-3 图输入），
 * 服务端按 pose 语义组织「图N是已定稿卡通形象」的提示词。
 *
 * 环境变量：
 *  - DASHSCOPE_API_KEY    百炼 API Key（必配，否则接口返回 503 NotConfigured）
 *  - CAT_SKIN_MODEL       模型名，默认 qwen-image-2.0-pro（旧 key 可改 qwen-image-edit）
 *  - DASHSCOPE_BASE_URL   默认 https://dashscope.aliyuncs.com（业务空间专属域名/新加坡地域可覆盖）
 *  - CAT_SKIN_MOCK=1      联调模式：不调真 API，返回 site/assets/poses/*.webp 内置素材
 *                         （仅供开发/测试走通全链路，产品上无 key 即禁用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POSES_DIR = path.join(ROOT, 'site', 'assets', 'poses')

const API_KEY = process.env.DASHSCOPE_API_KEY || ''
const MODEL = process.env.CAT_SKIN_MODEL || 'qwen-image-2.0-pro'
const BASE_URL = (process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '')
const MOCK = process.env.CAT_SKIN_MOCK === '1'

/** 可生成的姿态（与 skin.json v2 单帧文件一一对应） */
export const POSES = ['idle', 'walk1', 'walk2', 'sleep', 'drag', 'pet', 'tap']

/* ─────────────────────────── 提示词 ─────────────────────────── */

const STYLE =
  '一只干净的卡通吉祥物插画：大头小身的 Q 版比例、圆润的脸型和轮廓、流畅的深棕色描边、' +
  '奶油插画质感的柔和上色、色彩明亮温暖、厚涂儿童绘本风格'

const IDENTITY =
  '严格保留照片里这只猫的品种、毛色、花纹分布、眼睛颜色和五官特征——必须让人一眼认出是同一只猫'

/**
 * 通用输出约束。重点：纯白背景 + 无阴影。
 * app 端皮肤管线（src/main/skins.ts matteImage）用「四边漫水 + 中性灰白(min≥190,max-min≤14)」
 * 抠图，纯白背景可被干净地转成透明 PNG；阴影/地面线会残留脏边。
 */
const STYLE_RULES =
  '输出要求：画面中只有一只猫、完整全身、四周留白；纯白色背景；' +
  '不要阴影、不要地面线、不要文字、不要水印、不要边框、不要道具。'

const POSE_DESC = {
  idle:
    '正面朝前直立站姿：四脚落地自然放松地站着，尾巴自然弯绕在身侧，' +
    '眼睛圆睁平视前方，表情平静又有点发呆。',
  walk1:
    '正面朝镜头走来：左前爪抬起向前迈、右后爪蹬地，其余两脚落地，' +
    '身体轻微前倾，表情温和自然。',
  walk2:
    '正面朝镜头走来：右前爪抬起向前迈、左后爪蹬地，其余两脚落地，' +
    '身体轻微前倾，表情温和自然。',
  sleep:
    '蜷成一团睡觉：侧卧蜷成月牙形，闭眼，头枕在前爪上，尾巴绕住身体，' +
    '表情安详放松。',
  drag:
    '被拎起后颈悬空：整个身体被无形的手拎着后颈悬空，四肢自然下垂放松，' +
    '身体微微拉长，耳朵略向后抿，表情无奈又乖巧。',
  pet:
    '坐着眯眼享受抚摸：端坐，眼睛眯成缝闭着，头微微低下偏斜，' +
    '嘴角轻轻上扬，表情幸福惬意；画面中不要出现人手。',
  tap:
    '正面端坐敲键盘：端坐面向镜头，两只前爪抬在胸前向下做敲击键盘的动作，' +
    '表情专注又有点小兴奋。',
}

const NEGATIVE_PROMPT =
  '文字、水印、logo、边框、人手、人物、多余的猫、复杂背景、地面阴影、' +
  '照片写实风格、模糊、肢体畸形、多余肢体'

/**
 * 按 pose + 参考图张数组装提示词。
 * 约定：非 idle 姿态时，最后一张图 = 已定稿的卡通形象（walk2 为上一帧走姿，其余为 idle 稿），
 * 前面 1-2 张 = 真猫照片。
 */
export function buildPrompt(pose, nImages) {
  const desc = POSE_DESC[pose]
  if (!desc) throw Object.assign(new Error(`未知姿态 ${pose}`), { code: 'BadPose' })
  if (pose === 'idle' || nImages < 2) {
    const head = nImages > 1 ? `前面 ${nImages} 张图是同一只猫的照片。` : ''
    return `${head}把照片中的猫画成${STYLE}${IDENTITY}。姿态：${desc}${STYLE_RULES}`
  }
  const photoNote = nImages > 2 ? `前 ${nImages - 1} 张图是真猫照片，` : '第一张图是真猫照片，'
  if (pose === 'walk2') {
    return (
      `${photoNote}最后一张图是已定稿的卡通猫形象（同一角色的另一帧走姿）。` +
      `保持与定稿形象完全一致的角色特征、画风、比例与视角，参考真猫照片的毛色花纹细节，` +
      `画出这只卡通猫：${desc}要与定稿形象构成左右爪交替的一对连续走路动画帧。${STYLE_RULES}`
    )
  }
  return (
    `${photoNote}最后一张图是已定稿的卡通猫形象。` +
    `保持与定稿形象完全一致的角色特征、画风与比例，参考真猫照片的毛色花纹细节，` +
    `画出这只卡通猫：${desc}${STYLE_RULES}`
  )
}

/* ─────────────────────────── DashScope 调用 ─────────────────────────── */

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|bmp);base64,[A-Za-z0-9+/=]+$/
const GEN_TIMEOUT_MS = 240_000

/** 串行队列：同一时刻只打一发 DashScope（保护 QPS，也让进度可预期） */
let queue = Promise.resolve()
function enqueue(fn) {
  const run = queue.then(fn, fn)
  queue = run.then(() => {}, () => {})
  return run
}

async function dashscopeEdit(images, prompt) {
  const res = await fetch(`${BASE_URL}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      input: {
        messages: [
          {
            role: 'user',
            content: [...images.map((image) => ({ image })), { text: prompt }],
          },
        ],
      },
      parameters: {
        n: 1,
        size: '1024*1024',
        prompt_extend: false,
        watermark: false,
        negative_prompt: NEGATIVE_PROMPT,
      },
    }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  })
  let data
  try { data = await res.json() } catch { data = null }
  if (!res.ok || !data || data.code) {
    const code = data?.code || `HTTP${res.status}`
    const message = data?.message || `DashScope 返回 ${res.status}`
    throw Object.assign(new Error(message), { code })
  }
  const imgUrl = data?.output?.choices?.[0]?.message?.content?.find((c) => c && c.image)?.image
  if (!imgUrl) throw Object.assign(new Error('DashScope 未返回图像'), { code: 'NoImage' })
  // 产物 URL 24h 过期 + 浏览器无法直连 OSS（跨域），服务端代下载转 dataURL
  const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(60_000) })
  if (!imgRes.ok) throw Object.assign(new Error(`产物下载失败 HTTP${imgRes.status}`), { code: 'FetchImage' })
  const buf = Buffer.from(await imgRes.arrayBuffer())
  return { dataURL: `data:image/png;base64,${buf.toString('base64')}`, requestId: data.request_id || null }
}

/* ─────────────────────────── mock（联调专用） ─────────────────────────── */

const MOCK_FILES = {
  idle: 'cat-idle.webp',
  walk1: 'cat-walk-1.webp',
  walk2: 'cat-walk-2.webp',
  sleep: 'cat-sleep.webp',
  drag: 'cat-drag.webp',
  pet: 'cat-pet.webp',
  tap: 'cat-tap.webp',
}

async function mockGenerate(pose) {
  const file = path.join(POSES_DIR, MOCK_FILES[pose])
  if (!fs.existsSync(file)) throw Object.assign(new Error(`mock 素材缺失 ${file}`), { code: 'MockMissing' })
  await new Promise((r) => setTimeout(r, 700)) // 模拟生成耗时，让前端进度可见
  const b64 = fs.readFileSync(file).toString('base64')
  return { dataURL: `data:image/webp;base64,${b64}`, requestId: `mock-${pose}-${Date.now()}` }
}

/* ─────────────────────────── HTTP 接口 ─────────────────────────── */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { code: 'BodyTooLarge' })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 处理 /api/cat-skin/* 请求；返回 true 表示已接管（serve-site.mjs 据此短路静态文件逻辑）。
 */
export async function handleCatSkinApi(req, res, urlPath) {
  if (urlPath === '/api/cat-skin/status') {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, code: 'MethodNotAllowed', message: '仅支持 GET' }); return true }
    sendJson(res, 200, {
      ok: true,
      enabled: MOCK || !!API_KEY,
      mock: MOCK,
      model: MOCK ? 'mock' : MODEL,
      poses: POSES,
    })
    return true
  }

  if (urlPath === '/api/cat-skin/generate') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'MethodNotAllowed', message: '仅支持 POST' }); return true }
    if (!MOCK && !API_KEY) {
      sendJson(res, 503, {
        ok: false,
        code: 'NotConfigured',
        message: '服务端未配置 DASHSCOPE_API_KEY，无法调用 AI 生成（启动 site:dev 时注入环境变量即可）',
      })
      return true
    }
    let body
    try { body = JSON.parse(await readBody(req)) } catch (e) {
      sendJson(res, 400, { ok: false, code: 'BadJson', message: `请求体不是合法 JSON: ${e.message}` })
      return true
    }
    const { pose, images } = body || {}
    if (!POSES.includes(pose)) {
      sendJson(res, 400, { ok: false, code: 'BadPose', message: `pose 必须是 ${POSES.join('/')} 之一` })
      return true
    }
    if (!Array.isArray(images) || images.length < 1 || images.length > 3 || !images.every((s) => typeof s === 'string' && DATA_URL_RE.test(s))) {
      sendJson(res, 400, { ok: false, code: 'BadImages', message: 'images 需要 1-3 张 data:image/(png|jpeg|webp|bmp);base64 图片' })
      return true
    }
    const t0 = Date.now()
    try {
      const out = await enqueue(() => (MOCK ? mockGenerate(pose) : dashscopeEdit(images, buildPrompt(pose, images.length))))
      console.log(`[cat-skin] ${MOCK ? 'mock ' : ''}${pose} 完成 ${Date.now() - t0}ms`)
      sendJson(res, 200, { ok: true, pose, image: out.dataURL, requestId: out.requestId, mock: MOCK, ms: Date.now() - t0 })
    } catch (e) {
      console.error(`[cat-skin] ${pose} 失败:`, e.code || '', e.message)
      sendJson(res, 502, { ok: false, pose, code: e.code || 'GenerateFailed', message: e.message })
    }
    return true
  }

  sendJson(res, 404, { ok: false, code: 'NotFound', message: '未知接口' })
  return true
}
