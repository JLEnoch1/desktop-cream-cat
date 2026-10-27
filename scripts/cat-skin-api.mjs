/**
 * AI 毛发定制工坊 · 后端接口（仅随 scripts/serve-site.mjs 本地预览启用）。
 *
 * 职责：
 *  - GET  /api/cat-skin/status   → 服务是否可用（是否配置 Key / mock）+ 能力清单 + keySource(env|runtime)
 *  - POST /api/cat-skin/generate → 调百炼「千问-图像编辑」把用户猫照片转成指定目标素材
 *  - POST /api/cat-skin/check    → 测试连接：空 messages 探针验证 Key（零成本、不生成、不保存）
 *  - POST /api/cat-skin/config   → 保存运行时 Key（仅进程内存，不写盘；{key:null} 清除）
 *
 * 生成路线（路线 B，产品裁决 2026-10-26）：把照片里的猫**重绘成 Q 版卡通角色定稿**，
 * 再以定稿锁角色，批量产出「统一画风、同一只猫」的两类素材：
 *  1. 动作序列帧（POSES，7 件）：发呆/散步×2/打盹/被拎起/被摸头/敲键盘 → 可装进 app 的皮肤；
 *  2. 部件拆层稿（PARTS，12 件）：脸/头轮廓、左右眼、上下眉毛、嘴巴、双前爪、身体、尾巴、
 *     毛发遮挡层、眼睛高光/阴影层 → Live2D 式分层素材（画师二创/rigging 参考，app 不直接消费）。
 *
 * 画风（style）：pixel=像素游戏风（2026-10-27 裁决：唯一画风，chibi/flat 已下线）。
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
 *  - CAT_SKIN_MODEL       模型名，默认 qwen-image-2.0-pro（当前图像编辑推荐；qwen-image-edit 为早期模型）
 *  - DASHSCOPE_BASE_URL   默认 https://dashscope.aliyuncs.com（业务空间专属域名/新加坡地域可覆盖）
 *  - CAT_SKIN_MOCK=1      联调模式：不调真 API，返回 site/assets/poses/*.webp 内置素材
 *                         （仅供开发/测试走通全链路，产品上无 key 即禁用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POSES_DIR = path.join(ROOT, 'site', 'assets', 'poses')

const ENV_KEY = process.env.DASHSCOPE_API_KEY || ''
const ENV_MODEL = process.env.CAT_SKIN_MODEL || ''
const ENV_BASE = (process.env.DASHSCOPE_BASE_URL || '').replace(/\/+$/, '')
const DEFAULT_MODEL = 'qwen-image-2.0-pro'
const DEFAULT_BASE = 'https://dashscope.aliyuncs.com'
const MOCK = process.env.CAT_SKIN_MOCK === '1'

/** 页面「配置 API Key」面板注入的运行时配置（仅存进程内存：不写盘、不打日志明文、重启即失；env 优先） */
const runtimeCfg = { key: '', model: '', baseUrl: '' }
const effKey = () => ENV_KEY || runtimeCfg.key
const effModel = () => ENV_MODEL || runtimeCfg.model || DEFAULT_MODEL
const effBase = () => ENV_BASE || runtimeCfg.baseUrl || DEFAULT_BASE
const keySource = () => (ENV_KEY ? 'env' : runtimeCfg.key ? 'runtime' : null)

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

/** 画风：产品裁决 2026-10-27 —— 只保留像素游戏风（chibi/flat 已下线） */
export const STYLES = ['pixel']

/* ─────────────────────────── 提示词 ─────────────────────────── */

const STYLE_BLOCKS = {
  pixel:
    '像素游戏风角色稿：整幅图由清晰的方形像素块构成、像素边缘硬朗无抗锯齿、' +
    '限制调色板（约32色）、深色像素描边、用色块阶表现毛发明暗、大头小身的Q版比例、' +
    '复古桌宠/电子宠物游戏质感、动作感强',
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
  pixel: `${NEGATIVE_BASE}、照片写实风格、柔边、渐变、抗锯齿模糊、厚涂`,
}

/**
 * 按 target(pose|part) + 参考图张数 + 画风组装提示词。
 * 约定：非 idle 目标时，最后一张图 = 已定稿的卡通形象（walk2 优先用 walk1 定稿，
 * 其余姿态与全部部件用 idle 定稿），前面 1-2 张 = 真猫照片。
 */
export function buildPrompt(target, nImages, style = 'pixel') {
  const styleBlock = STYLE_BLOCKS[style] || STYLE_BLOCKS.pixel
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
  const res = await fetch(`${effBase()}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${effKey()}` },
    body: JSON.stringify({
      model: effModel(),
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
        negative_prompt: NEGATIVE_BY_STYLE[style] || NEGATIVE_BY_STYLE.pixel,
      },
    }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  })
  let data
  try { data = await res.json() } catch { data = null }
  if (!res.ok || !data || data.code) {
    const code = data?.code || `HTTP${res.status}`
    const message = data?.message || `DashScope 返回 ${res.status}${data ? '' : '（非百炼 JSON 响应：请检查「高级选项」服务地址是否为 https://dashscope.aliyuncs.com、模型名是否为图像编辑模型如 qwen-image-2.0-pro——文本/Anthropic 网关不适用）'}`
    throw Object.assign(new Error(message), { code })
  }
  const imgUrl = data?.output?.choices?.[0]?.message?.content?.find((c) => c && c.image)?.image
  if (!imgUrl) throw Object.assign(new Error('DashScope 未返回图像'), { code: 'NoImage' })
  // 产物 URL 24h 过期 + 浏览器无法直连 OSS（跨域），服务端代下载转 dataURL
  return { ...(await downloadAsDataUrl(imgUrl)), requestId: data.request_id || null }
}

/** 产物 URL（24h 过期 + OSS 跨域）→ 服务端代下载转 dataURL */
async function downloadAsDataUrl(imgUrl) {
  const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(60_000) })
  if (!imgRes.ok) throw Object.assign(new Error(`产物下载失败 HTTP${imgRes.status}`), { code: 'FetchImage' })
  const buf = Buffer.from(await imgRes.arrayBuffer())
  return { dataURL: `data:image/png;base64,${buf.toString('base64')}` }
}

/* ── 引擎二：通义万相图像编辑（wanx2.1-imageedit 等，异步任务 API）──
 * 与千问同一个百炼 Key；账号无 qwen-image 权限时的备选（模型广场搜「万相-图像编辑」）。
 * 仅支持单张底图 → 取 images 最后一张（派生姿态=idle 定稿，idle=最后一张照片），
 * 与千问「输出比例以最后一张为准」的参考语义一致。0.14 元/张（北京，2026-10 原价）。 */
const WANX_POLL_MS = 3_000

function isWanxModel(model) { return /^wanx/i.test(String(model || '')) }

async function dashscopeWanxEdit(images, prompt) {
  const t0 = Date.now()
  const res = await fetch(`${effBase()}/api/v1/services/aigc/image2image/image-synthesis`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${effKey()}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: effModel(),
      input: { function: 'description_edit', prompt, base_image_url: images[images.length - 1] },
      parameters: { n: 1 },
    }),
    signal: AbortSignal.timeout(60_000),
  })
  let data = null
  try { data = await res.json() } catch { data = null }
  if (!res.ok || !data || data.code) {
    const code = data?.code || `HTTP${res.status}`
    throw Object.assign(new Error(data?.message || `DashScope 返回 ${res.status}（万相任务创建失败${data ? '' : '，非百炼 JSON 响应：检查服务地址'}）`), { code })
  }
  const taskId = data?.output?.task_id
  if (!taskId) throw Object.assign(new Error('万相未返回 task_id'), { code: 'NoTaskId' })
  // 轮询任务直到 SUCCEEDED / FAILED / 超时
  while (Date.now() - t0 < GEN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, WANX_POLL_MS))
    const pr = await fetch(`${effBase()}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${effKey()}` },
      signal: AbortSignal.timeout(30_000),
    })
    let pd = null
    try { pd = await pr.json() } catch { pd = null }
    if (!pd || pd.code) {
      throw Object.assign(new Error(pd?.message || `任务查询失败 HTTP${pr.status}`), { code: pd?.code || `HTTP${pr.status}` })
    }
    const st = pd?.output?.task_status
    if (st === 'SUCCEEDED') {
      const imgUrl = pd?.output?.results?.[0]?.url
      if (!imgUrl) throw Object.assign(new Error('万相任务成功但未返回图像 URL'), { code: 'NoImage' })
      return { ...(await downloadAsDataUrl(imgUrl)), requestId: pd.request_id || null }
    }
    if (st && st !== 'PENDING' && st !== 'RUNNING') { // FAILED / CANCELED / UNKNOWN
      throw Object.assign(new Error(pd?.output?.message || `万相任务 ${st}`), { code: pd?.output?.code || `Task${st}` })
    }
  }
  throw Object.assign(new Error(`万相任务超时（${GEN_TIMEOUT_MS / 1000}s），task_id=${taskId}`), { code: 'TaskTimeout' })
}

/** 引擎分派：wanx* 走异步任务 API，其余走千问同步 multimodal API */
function dashscopeGenerate(images, prompt, style) {
  return isWanxModel(effModel()) ? dashscopeWanxEdit(images, prompt) : dashscopeEdit(images, prompt, style)
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

/* ─────────────────────────── Key 校验探针（零成本） ─────────────────────────── */

const KEY_RE = /^sk-[A-Za-z0-9_-]{12,}$/;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * 零成本探针（按引擎选端点）：
 * - 千问（默认）：空 messages 打 multimodal-generation；
 * - 万相（wanx*）：空 input 打 image2image/image-synthesis（async 头）。
 * 有效 Key → 参数校验层报错（不生成、不计费）→ valid:true；
 * 非 JSON / 鉴权 / 权限 / 模型错 / 未知码 → 一律拒（见下方分级）。
 */
async function probeKey(key, model, baseUrl) {
  const t0 = Date.now();
  const wanx = isWanxModel(model);
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/services/aigc/${wanx ? 'image2image/image-synthesis' : 'multimodal-generation/generation'}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...(wanx ? { 'X-DashScope-Async': 'enable' } : {}),
      },
      body: JSON.stringify(wanx ? { model, input: {} } : { model, input: { messages: [] } }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      valid: false,
      code: 'ProbeFailed',
      message: e?.name === 'TimeoutError' ? `连不上百炼服务（超时 ${PROBE_TIMEOUT_MS / 1000}s），Key 未保存` : `连不上百炼服务：${e?.message || e}，Key 未保存`,
      ms: Date.now() - t0,
    };
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应按状态码判 */ }
  const ms = Date.now() - t0;
  const code = data?.code || '';
  const raw = data?.message || '';

  // 1) 非百炼 JSON 响应（网关/HTML 404 等）→ 服务地址不是 DashScope 图像 API
  if (!data) {
    return {
      valid: false, code: `HTTP${res.status}`, ms,
      message: `服务地址返回 HTTP ${res.status} 且非百炼 JSON 响应——「服务地址」应为 https://dashscope.aliyuncs.com，且需百炼图像编辑 API（文本/Anthropic 网关如 ai-gateway…/ai-llm/anthropic 不适用）`,
    };
  }
  // 2) Key 有效但无权访问该资源/模型（最常见的误配：文本 Key、未开通图像模型）——先于「无效」判定
  if (/Forbidden|ResourceForbidden|AccessDenied|NoPermission|Arrearage|Throttling/i.test(code) || res.status === 403) {
    const arrears = /Arrearage/i.test(code);
    return {
      valid: false, code: code || `HTTP${res.status}`, ms,
      message: arrears
        ? `${raw || code}——账户欠费/未开通，请在百炼控制台充值或开通后重试`
        : `${raw || code}——Key 被识别但无权访问该模型/资源。可先在「高级选项」把模型名改为 wanx2.1-imageedit（通义万相图像编辑，同一个百炼 Key，0.14 元/张）再测；若也不行，到百炼控制台「模型广场」搜 qwen-image / 万相-图像编辑 确认已开通（子业务空间需管理员授权；北京/新加坡地域 Key 不可混用）`,
    };
  }
  // 3) Key 无效 / 鉴权失败
  if (res.status === 401 || /InvalidApiKey|Unauthorized|InvalidAuthentication/i.test(code)) {
    return { valid: false, code: code || `HTTP${res.status}`, ms, message: raw || `API Key 无效（HTTP ${res.status}）` };
  }
  // 4) 模型不存在 / 名称错
  if (/Model\.?NotFound|ModelNotFound|InvalidModel/i.test(code)) {
    return { valid: false, code, ms, message: `${raw || code}——模型名可能不对：留空用默认 qwen-image-2.0-pro，或填 wanx2.1-imageedit（万相图像编辑）/ qwen-image-2.0；qwen-image-edit 为早期模型` };
  }
  // 5) 走到参数校验层（空 messages 被拒）或 2xx → 鉴权+端点+模型全部 OK
  if (res.ok || /InvalidParameter|BadRequest\.?Input|MissingParameter|InvalidRequest/i.test(code)) {
    return { valid: true, warning: '', ms };
  }
  // 6) 其它未知错误码：保守判失败（不放行），透传原始信息
  return { valid: false, code: code || `HTTP${res.status}`, ms, message: raw || `百炼返回 ${code || res.status}（未识别，保守拒绝保存）` };
}

function sanitizeCfg(body) {
  const key = String(body?.key ?? '').trim().slice(0, 512);
  const model = String(body?.model ?? '').trim().slice(0, 64);
  const baseUrl = String(body?.baseUrl ?? '').trim().replace(/\/+$/, '').slice(0, 200);
  if (model && !/^[\w.-]+$/.test(model)) throw Object.assign(new Error('模型名只允许字母数字与 . _ -'), { code: 'BadCfg' });
  if (baseUrl && !/^https?:\/\/[\w.-]+(:\d+)?([/?][\w./?&=%-]*)?$/.test(baseUrl)) throw Object.assign(new Error('服务地址需为合法 http(s) 地址'), { code: 'BadCfg' });
  return { key, model, baseUrl };
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
      enabled: MOCK || !!effKey(),
      mock: MOCK,
      model: MOCK ? 'mock' : effModel(),
      keySource: MOCK ? null : keySource(),
      poses: POSES,
      parts: PARTS,
      styles: STYLES,
    })
    return true
  }

  if (urlPath === '/api/cat-skin/check' || urlPath === '/api/cat-skin/config') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'MethodNotAllowed', message: '仅支持 POST' }); return true }
    const isConfig = urlPath.endsWith('config')
    let body
    try { body = JSON.parse(await readBody(req, 16 * 1024)) } catch (e) {
      sendJson(res, 400, { ok: false, code: 'BadJson', message: `请求体不是合法 JSON: ${e.message}` }); return true
    }
    // config 专属：清除运行时 Key（key:null）
    if (isConfig && (body?.key === null || body?.key === '')) {
      runtimeCfg.key = ''; runtimeCfg.model = ''; runtimeCfg.baseUrl = ''
      console.log('[cat-skin] config: 运行时 Key 已清除')
      sendJson(res, 200, { ok: true, cleared: true, keySource: keySource(), enabled: MOCK || !!effKey() })
      return true
    }
    let cfg
    try { cfg = sanitizeCfg(body) } catch (e) {
      sendJson(res, 400, { ok: false, code: 'BadCfg', message: e.message }); return true
    }
    if (!KEY_RE.test(cfg.key)) {
      sendJson(res, 400, { ok: false, code: 'BadKeyFormat', message: 'API Key 应以 sk- 开头（百炼控制台 → API-KEY 页获取）' }); return true
    }
    const model = cfg.model || ENV_MODEL || DEFAULT_MODEL
    const baseUrl = cfg.baseUrl || ENV_BASE || DEFAULT_BASE
    const probe = await probeKey(cfg.key, model, baseUrl)
    if (!probe.valid) {
      sendJson(res, 400, { ok: false, code: probe.code, message: probe.message, ms: probe.ms })
      return true
    }
    if (isConfig) {
      runtimeCfg.key = cfg.key; runtimeCfg.model = cfg.model; runtimeCfg.baseUrl = cfg.baseUrl
      console.log(`[cat-skin] config: Key 已存入内存（尾号 …${cfg.key.slice(-4)}），model=${model}，base=${baseUrl}`)
    }
    sendJson(res, 200, {
      ok: true, valid: true, saved: isConfig, ms: probe.ms, model,
      warning: probe.warning || '',
      keySource: isConfig ? keySource() : null,
      enabled: MOCK || !!effKey(),
    })
    return true
  }

  if (urlPath === '/api/cat-skin/generate') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, code: 'MethodNotAllowed', message: '仅支持 POST' }); return true }
    if (!MOCK && !effKey()) {
      sendJson(res, 503, {
        ok: false,
        code: 'NotConfigured',
        message: '未配置 API Key：请在页面「配置百炼 API Key」面板填写，或启动服务时注入 DASHSCOPE_API_KEY',
      })
      return true
    }
    let body
    try { body = JSON.parse(await readBody(req)) } catch (e) {
      sendJson(res, 400, { ok: false, code: 'BadJson', message: `请求体不是合法 JSON: ${e.message}` })
      return true
    }
    const { pose, part, images } = body || {}
    const style = body?.style || 'pixel'
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
      const out = await enqueue(() => (MOCK ? mockGenerate(target) : dashscopeGenerate(images, buildPrompt(target, images.length, style), style)))
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
