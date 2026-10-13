#!/usr/bin/env node
/**
 * magpie 网关能力探针 —— GEO 能不能接这个网关，一次问清楚。
 *
 * 只回答三个决定性的问题：
 *   1. 网关在不在、认不认 Anthropic 协议
 *   2. web_search 工具能不能触发（引用率的命脉 —— 没有它「引用率」这维永远无法核实）
 *   3. 触发之后，来源是结构化 citation 还是只能从正文里抠 URL
 *      —— 这决定 GEO 的 mentions() 要不要改判据，而不是只改配置
 */
const BASE = process.env.MAGPIE_BASE || 'http://127.0.0.1:3425'
const KEY = process.env.MAGPIE_KEY || 'magpie'

async function ask(model, { tools = true, maxTokens = 1500, prompt } = {}) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt ?? '有哪些好用的 AI 视频生成工具？请给出信息来源。' }],
  }
  if (tools) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch { return { ok: false, raw: text.slice(0, 200) } }
  if (j.type === 'error') return { ok: false, err: j?.error?.message ?? 'unknown' }
  return { ok: true, ...j }
}

/** 把来源信息从任何形状里挖出来：结构化 citation、server_tool_use、还是正文里的裸 URL */
function harvest(content = []) {
  const urls = new Set()
  let citations = 0, toolUse = 0, serverTool = 0
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(walk)
    if (v.type === 'citations') citations++
    if (v.type === 'server_tool_use') serverTool++
    if (v.type === 'tool_use') toolUse++
    if (typeof v.url === 'string' && /^https?:/.test(v.url)) urls.add(v.url)
    for (const val of Object.values(v)) walk(val)
  }
  walk(content)
  const plain = content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
  for (const m of plain.matchAll(/https?:\/\/[^\s)\]，。、"'`]+/g)) urls.add(m[0])
  return { citations, serverTool, toolUse, urls: [...urls], text: plain }
}

const MODELS = process.argv.slice(2)
if (!MODELS.length) { console.error('用法: node probe-magpie.mjs <model> [model...]'); process.exit(1) }

const rows = []
for (const m of MODELS) {
  process.stderr.write(` probing ${m} … `)
  const r = await ask(m)
  if (!r.ok) {
    process.stderr.write('失败\n')
    rows.push({ model: m, ok: false, err: r.err || r.raw })
    continue
  }
  const h = harvest(r.content)
  rows.push({
    model: m, ok: true,
    routed: r.model,
    stop: r.stop_reason,
    blockTypes: [...new Set((r.content || []).map((b) => b.type))].join(','),
    citations: h.citations,
    serverTool: h.serverTool,
    urlCount: h.urls.length,
    sampleUrls: h.urls.slice(0, 4),
    text: h.text.slice(0, 400),
    usage: r.usage,
  })
  process.stderr.write('ok\n')
}

console.log(JSON.stringify(rows, null, 2))