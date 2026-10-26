/**
 * AI 毛发定制工坊 · 后端接口（仅随 scripts/serve-site.mjs 本地预览启用）。
 *
 * 职责：
 *  - GET  /api/cat-skin/status   → 服务是否可用（是否配置 DASHSCOPE_API_KEY / mock）+ 能力清单
 *  - POST /api/cat-skin/generate → 调百炼「千问-图像编辑」把用户猫照片转成指定目标素材
 *
 * 生成路线（路线 B，产品裁决 2026-10-26）：把照片里的猫**重绘成 Q 版卡通角色定稿**，
 * 再以定稿锁角色，批量产出「统一画风、同一只猫」的两类素材：
 *  1. 动作序列帧（POSES，7 件）：发呆/散步×2/打盹/被拎起/被摸头/敲键盘 → 可装进 app 的皮肤；
 *  2. 部件拆层稿（PARTS，12 件）：脸/头轮廓、左右眼、上下眉毛、嘴巴、双前爪、身体、尾巴、
 *     毛发遮挡层、眼睛高光/阴影层 → Live2D 式分层素材（画师二创/rigging 参考，app 不直接消费）。
 *
 * 画风（style）：chibi=厚涂 Q 版（默认推荐）/ flat=扁平 Q 版 / pixel=像素游戏风（传统桌宠感）。
 *
 * 真 AI 路线：DashScope multimodal-generation（qwen-image 系列图像编辑），
 * Base64 图片直传、服务端代下载产物图（结果 URL 只有 24h 有效，且避免浏览器跨域）。
 * 提示词全部收在服务端（STYLE_BLOCKS/POSE_DESC/PART_DESC），客户端只传 {pose|part, style, images}。
 *
 * 角色一致性：客户端按 idle → 其余姿态 → 部件 顺序串行生成，非 idle 目标把「已定稿形象图」
 * 作为最后一张参考图传入（qwen 支持 1-3 图输入），提示词明确「与定稿完全一致」。
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

/** 动作序列帧（与 skin.json v2 单帧文件一一对应） */
export const POSES = ['idle', 'walk1', 'walk2', 'sleep', 'drag', 'pet', 'tap']

/** 部件拆层稿（Live2D 式素材，id 即 parts/ 下的文件名） */
export const PARTS = [
  { id: 'face', label: '脸/头轮廓' },
  { id: 'body', label: '身体' },
  { id: 'tail', label: '尾巴' },
  { id: 'paw-l', label: '前爪左' },
  { id: 'paw-r', label: '前爪右' },
  { id: 'mouth', label: '嘴巴' },
  { id: 'eye-l', label: '左眼' },
  { id: 'eye-r', label: '右眼' },
  { id: 'brow-up', label: '眉毛上' },
  { id: 'brow-low', label: '眉毛下' },
  { id: 'fur-overlay', label: '毛发遮挡层' },
  { id: 'eye-light', label: '眼睛高光/阴影层' },
]
const PART_IDS = PARTS.map((p) => p.id)

/** 画风 */
export const STYLES = ['chibi', 'flat', 'pixel']

/* ─────────────────────────── 提示词 ─────────────────────────── */

const STYLE_BLOCKS = {
  chibi:
    '厚涂Q版卡通角色稿：大头小身的Q版比例、圆润的脸型和轮廓、流畅的深棕色描边、' +
    '厚涂上色带柔和的光影过渡、奶油质感的柔和配色、色彩明亮温暖、儿童绘本插画品质',
  flat:
    '扁平Q版卡通角色稿：大头小身的Q版比例、圆润的脸型和轮廓、粗细均匀的深棕色描边、' +
    '扁平插画上色——干净的色块填充、极少渐变、无复杂光影、色彩明亮温暖、贴纸般干净利落',
  pixel:
    '像素游戏风角色稿：整幅图由清晰的方形像素块构成、像素边缘硬朗无抗锯齿、' +
    '限制调色板（约32色）、深色像素描边、用色块阶表现毛发明暗、大头小身的Q版比例、' +
    '复古桌宠/电子宠物游戏质感',
}

const IDENTITY =
  '严格保留照片里这只猫的品种、毛色、花纹分布、眼睛颜色和五官特征——必须让人一眼认出是同一只猫'

/**
 * 通用输出约束。重点：纯白背景 + 无阴影。
 * app 端皮肤管线（src/main/skins.ts matteImage）用「四边漫水 + 中性灰白(min≥190,max-min≤14)」
 * 抠图，纯白背景可被干净地转成透明 PNG；阴影/地面线会残留脏边。
 */
const POSE_RULES =
  '输出要求：画面中只有一只猫、完整全身、四周留白；纯白色背景；' +
  '不要阴影、不要地面线、不要文字、不要水印、不要边框、不要道具。'

const PART_RULES =
  '这是用于桌宠分层动画（Live2D 式部件稿）的单部件素材：保持与定稿形象完全一致的画风、配色、' +
  '描边与花纹特征；只画要求的这一个部件，部件居中、完整、四周留白；纯白色背景；' +
  '不要阴影、不要文字、不要其他部件、不要整只猫、不要拼合展示。'

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

const PART_DESC = {
  'face':
    '脸/头轮廓层：完整的头部外形——脸型、双耳、头顶与脸颊的毛发底色和花纹；' +
    '眼部与口鼻区域保持脸部底色、不画眼睛眉毛嘴巴细节（它们会作为独立图层叠加）。',
  'body':
    '身体层：完整躯干（颈部以下到臀部，含胸腹毛色与花纹、四肢根部），' +
    '不画头部、不画尾巴、不画悬空的前爪。',
  'tail':
    '尾巴层：单独一条完整尾巴，保持定稿的尾巴花纹与毛尖颜色，自然弯曲的站姿尾形。',
  'paw-l':
    '前爪层（画面左侧那只）：单独一只微微抬起的前爪，含爪尖与肉垫细节，毛色与定稿一致。',
  'paw-r':
    '前爪层（画面右侧那只）：单独一只微微抬起的前爪，含爪尖与肉垫细节，毛色与定稿一致。',
  'mouth':
    '嘴巴层：单独的口鼻部件——鼻头、嘴线、下巴，不含脸部其他部分。',
  'eye-l':
    '眼睛层（画面左侧那只）：单独一只完整眼睛——眼眶、虹膜、瞳孔、眼线，眼色与定稿一致。',
  'eye-r':
    '眼睛层（画面右侧那只）：单独一只完整眼睛——眼眶、虹膜、瞳孔、眼线，眼色与定稿一致。',
  'brow-up':
    '眉毛上层：眼部上方的眉毛/额部花纹形状（猫无明显眉毛时，按定稿画风画一对与毛色协调的' +
    '表情眉形），左右各一段、单独悬浮。',
  'brow-low':
    '眉毛下层：眼部下方的下眼线/卧蚕形状线条，左右各一段、单独悬浮，与定稿眼线风格一致。',
  'fur-overlay':
    '毛发遮挡层：只画会叠在其他部件之上的毛发缕——额前刘海、垂落脸颊两侧的毛发、胸前毛尖，' +
    '呈悬浮散状排列，毛色花纹与定稿一致。',
  'eye-light':
    '眼睛高光/阴影层：只画双眼的高光点与眼内阴影形状，按定稿双眼的位置与大小排布，' +
    '单独悬浮在纯白背景上。',
}

const NEGATIVE_BASE =
  '文字、水印、logo、边框、人手、人物、多余的猫、复杂背景、地面阴影、模糊、肢体畸形、多余肢体'
const NEGATIVE_BY_STYLE = {
  chibi: `${NEGATIVE_BASE}、照片写实风格、像素风`,
  flat: `${NEGATIVE_BASE}、照片写实风格、像素风、厚涂光影`,
  pixel: `${NEGATIVE_BASE}、照片写实风格、柔边、渐变、抗锯齿模糊、厚涂`,
}

/**
 * 按 target(pose|part) + 参考图张数 + 画风组装提示词。
 * 约定：非 idle 目标时，最后一张图 = 已定稿的卡通形象（walk2 优先用 walk1 定稿，
 * 其余姿态与全部部件用 idle 定稿），前面 1-2 张 = 真猫照片。
 */
export function buildPrompt(target, nImages, style = 'chibi') {
  const styleBlock = STYLE_BLOCKS[style] || STYLE_BLOCKS.chibi
  if (POSES.includes(target)) return buildPosePrompt(target, nImages, styleBlock)
  if (PART_IDS.includes(target)) return buildPartPrompt(target, nImages)
  throw Object.assign(new Error(`未知目标 ${target}`), { code: 'BadTarget' })
}

function photoNote(nImages, withRef) {
  if (!withRef) return nImages > 1 ? `前面 ${nImages} 张图是同一只猫的照片。` : ''
  return nImages > 2 ? `前 ${nImages - 1} 张图是真猫照片，` : '第一张图是真猫照片，'
}

function buildPosePrompt(pose, nImages, styleBlock) {
  const desc = POSE_DESC[pose]
  if (pose === 'idle' || nImages < 2) {
    return (
      `${photoNote(nImages, false)}把照片中的猫重绘成${styleBlock}${IDENTITY}。` +
      `这是同一角色的定稿，后续动作序列帧与部件拆层都以它为准，表情与动作可控、形象可复用。` +
      `姿态：${desc}${POSE_RULES}`
    )
  }
  if (pose === 'walk2') {
    return (
      `${photoNote(nImages, true)}最后一张图是已定稿的卡通猫形象（同一角色的另一帧走姿）。` +
      `保持与定稿形象完全一致的角色特征、画风、比例与视角，参考真猫照片的毛色花纹细节，` +
      `画出这只卡通猫：${desc}要与定稿形象构成左右爪交替的一对连续走路动画帧。${POSE_RULES}`
    )
  }
  return (
    `${photoNote(nImages, true)}最后一张图是已定稿的卡通猫形象。` +
    `保持与定稿形象完全一致的角色特征、画风与比例，参考真猫照片的毛色花纹细节，` +
    `画出这只卡通猫：${desc}${POSE_RULES}`
  )
}

function buildPartPrompt(part, nImages) {
  const desc = PART_DESC[part]
  if (nImages < 2) {
    // 无定稿参考（客户端未生成 idle 就单发部件）：退化为一图两用
    return `${photoNote(nImages, false)}把照片中的猫按统一画风画成卡通角色，然后只输出其中一个部件。${desc}${PART_RULES}`
  }
  return `${photoNote(nImages, true)}最后一张图是已定稿的卡通猫形象。${desc}${PART_RULES}`
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

async function dashscopeEdit(images, prompt, style) {
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
        negative_prompt: NEGATIVE_BY_STYLE[style] || NEGATIVE_BY_STYLE.chibi,
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
const MOCK_POOL = Object.values(MOCK_FILES)

async function mockGenerate(target) {
  const file = MOCK_FILES[target] || MOCK_POOL[PART_IDS.indexOf(target) % MOCK_POOL.length]
  const p = path.join(POSES_DIR, file)
  if (!fs.existsSync(p)) throw Object.assign(new Error(`mock 素材缺失 ${p}`), { code: 'MockMissing' })
  await new Promise((r) => setTimeout(r, 700)) // 模拟生成耗时，让前端进度可见
  const b64 = fs.readFileSync(p).toString('base64')
  return { dataURL: `data:image/webp;base64,${b64}`, requestId: `mock-${target}-${Date.now()}` }
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
      parts: PARTS,
      styles: STYLES,
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
    const { pose, part, images } = body || {}
    const style = body?.style || 'chibi'
    const target = pose || part
    const kind = pose ? 'pose' : 'part'
    if ((pose && part) || !target) {
      sendJson(res, 400, { ok: false, code: 'BadTarget', message: 'pose 与 part 二选一（必填其一）' })
      return true
    }
    if (!POSES.includes(target) && !PART_IDS.includes(target)) {
      sendJson(res, 400, { ok: false, code: 'BadTarget', message: `目标必须是姿态(${POSES.join('/')})或部件(${PART_IDS.join('/')})之一` })
      return true
    }
    if (!STYLES.includes(style)) {
      sendJson(res, 400, { ok: false, code: 'BadStyle', message: `style 必须是 ${STYLES.join('/')} 之一` })
      return true
    }
    if (!Array.isArray(images) || images.length < 1 || images.length > 3 || !images.every((s) => typeof s === 'string' && DATA_URL_RE.test(s))) {
      sendJson(res, 400, { ok: false, code: 'BadImages', message: 'images 需要 1-3 张 data:image/(png|jpeg|webp|bmp);base64 图片' })
      return true
    }
    const t0 = Date.now()
    try {
      const out = await enqueue(() => (MOCK ? mockGenerate(target) : dashscopeEdit(images, buildPrompt(target, images.length, style), style)))
      console.log(`[cat-skin] ${MOCK ? 'mock ' : ''}${style}/${kind}:${target} 完成 ${Date.now() - t0}ms`)
      sendJson(res, 200, { ok: true, target, kind, style, image: out.dataURL, requestId: out.requestId, mock: MOCK, ms: Date.now() - t0 })
    } catch (e) {
      console.error(`[cat-skin] ${target} 失败:`, e.code || '', e.message)
      sendJson(res, 502, { ok: false, target, code: e.code || 'GenerateFailed', message: e.message })
    }
    return true
  }

  sendJson(res, 404, { ok: false, code: 'NotFound', message: '未知接口' })
  return true
}
