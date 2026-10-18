import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from "zod"
import { chromium } from "playwright"

import path from "path"
import { fileURLToPath } from 'url'
import os from "os"
import fs from "fs/promises"
import http from "http"

// ── Configuration (defaults, overridable via CLI) ────────────────────────────
const config = {
  name: "Get Youtube Video Title and Subtitle (Headless Browser)",
  version: "1.0.0",
  defaultPort: 12002,
  chunkSizeBytes: 15000,      // max bytes per stdio chunk (~15 KB)
  cacheTtlMs: 10 * 60 * 1000, // 10 minutes
  navTimeoutMs: 45000,        // page navigation timeout
  panelTimeoutMs: 20000,      // transcript panel load timeout
}

// ── Runtime constants (derived from CLI args) ────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/
const VALID_SORT_OPTIONS = ['top', 'newest']
const VALID_LANG_CODES = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/

// ── CLI argument parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2)
const mode = args.includes('--http') ? 'http' : 'stdio'
const portMatch = args.find(arg => arg.startsWith('--port='))
const port = portMatch ? parseInt(portMatch.split('=')[1], 10) : config.defaultPort

// Extract --chunk-size=N (bytes). Accepts plain number or suffix (KB/MB).
let cliChunkSize = null
const chunkSizeMatch = args.find(arg => arg.startsWith('--chunk-size='))
if (chunkSizeMatch) {
  const raw = chunkSizeMatch.split('=')[1].trim().toUpperCase()
  const multiplier = raw.endsWith('KB') ? 1024 : raw.endsWith('MB') ? 1024 * 1024 : 1
  cliChunkSize = parseInt(raw.replace(/KB|MB$/, ''), 10) * multiplier
}
const CHUNK_SIZE = cliChunkSize ?? config.chunkSizeBytes

// Extract --profile=PATH (persistent browser profile directory)
const profileMatch = args.find(arg => arg.startsWith('--profile='))
const PROFILE_DIR = profileMatch
  ? path.resolve(profileMatch.split('=')[1])
  : path.join(__dirname, '.browser-profile')

// ── Cache helpers ────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '.cache')

async function ensureCacheDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }) } catch (_) { /* ignore */ }
}

function getCachePath(video_id, lang) {
  const safeLang = lang.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(CACHE_DIR, `${video_id}_${safeLang}.json`)
}

async function readCache(cachePath) {
  try {
    const data = await fs.readFile(cachePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (Date.now() - parsed.timestamp > config.cacheTtlMs) {
      await fs.unlink(cachePath)
      return null
    }
    return parsed
  } catch (_) { return null }
}

async function writeCache(cachePath, text) {
  await fs.writeFile(cachePath, JSON.stringify({ text, timestamp: Date.now() }))
}

async function cleanCache() {
  await ensureCacheDir()
  try {
    const files = await fs.readdir(CACHE_DIR)
    for (const file of files) {
      const fp = path.join(CACHE_DIR, file)
      try {
        const stat = await fs.stat(fp)
        if (Date.now() - stat.mtimeMs > config.cacheTtlMs) {
          await fs.unlink(fp)
        }
      } catch (_) { /* skip */ }
    }
  } catch (_) { /* skip */ }
}

// ── Chunking helpers ─────────────────────────────────────────────────────────
function splitIntoChunks(text, title) {
  const prefix = (n, total) => `--- Part ${n}/${total} (video: ${title}) ---\n`
  const chunks = []
  let remaining = text

  const estimatedTotal = Math.max(1, Math.ceil(text.length / CHUNK_SIZE))

  let i = 1
  while (remaining.length > 0) {
    const p = prefix(i, estimatedTotal)
    const available = CHUNK_SIZE - Buffer.byteLength(p)
    if (remaining.length <= available) {
      chunks.push(p + remaining)
      remaining = ''
    } else {
      let cut = available
      while (cut > 0 && remaining[cut] !== ' ' && remaining[cut] !== '\n') {
        cut--
      }
      if (cut === 0) cut = available
      chunks.push(p + remaining.slice(0, cut))
      remaining = remaining.slice(cut).trimStart()
    }
    i++
  }

  // Fix prefixes if estimate was wrong
  if (estimatedTotal !== chunks.length) {
    for (let c = 0; c < chunks.length; c++) {
      const oldPrefix = `--- Part ${c + 1}/${estimatedTotal}`
      const newPrefix = `--- Part ${c + 1}/${chunks.length}`
      chunks[c] = chunks[c].replace(oldPrefix, newPrefix)
    }
  }

  return chunks
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// ── Timestamp helpers ────────────────────────────────────────────────────────
// YouTube segment timestamps look like "0:04" or "1:02:33".
// Format them like the yt-dlp MCP's LRC output: [M:SS] (hours kept when present).
function formatTimestamp(ts) {
  const parts = ts.split(':').map(p => parseInt(p, 10))
  if (parts.some(isNaN)) return `[${ts}]`
  let hours = 0, minutes, seconds
  if (parts.length >= 3) {
    seconds = parts.pop()
    minutes = parts.pop()
    hours = parts.pop()
  } else {
    seconds = parts[1]
    minutes = parts[0]
  }
  const displaySec = String(seconds).padStart(2, '0')
  if (hours > 0) {
    const displayMin = String(minutes).padStart(2, '0')
    return `[${hours}:${displayMin}:${displaySec}]`
  }
  const displayMin = minutes < 10 ? String(minutes) : String(minutes).padStart(2, '0')
  return `[${displayMin}:${displaySec}]`
}

// Convert [ts, text] pairs into deduplicated "[M:SS] text" lines (one per segment)
function segmentsToTimestampedText(segments) {
  const result = []
  const seenText = new Set()

  for (const [ts, rawText] of segments) {
    const textPart = rawText.replace(/\s+/g, ' ').trim()
    if (!textPart) continue
    // Deduplicate by text content only (auto-captions often repeat with tiny timing diffs)
    if (!seenText.has(textPart)) {
      seenText.add(textPart)
      result.push(`${formatTimestamp(ts)} ${textPart}`)
    }
  }

  return result.join('\n')
}

// ── Browser manager (persistent profile, serialized access) ─────────────────
// A persistent user-data-dir can only be opened by one browser process at a
// time, so all browser work is funneled through a single promise queue.
let browserQueue = Promise.resolve()
function serialize(fn) {
  const run = browserQueue.then(fn, fn)
  browserQueue = run.then(() => {}, () => {})
  return run
}

let contextCache = null // { context, headless }

const BROWSER_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
]

// Spoof a normal Chrome UA — the default headless UA contains "HeadlessChrome"
// which YouTube fingerprints.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Consent-bypass cookies: skip the EU "Before you continue" interstitial.
const CONSENT_COOKIES = [
  { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.youtube.com', path: '/' },
  { name: 'CONSENT', value: 'YES+cb.20220301-09-p0.en+FX+410', domain: '.youtube.com', path: '/' },
]

async function getContext(headless) {
  if (contextCache) {
    if (contextCache.headless === headless && contextCache.context.browser()?.isConnected()) {
      return contextCache.context
    }
    // Headless mode changed (e.g. login tool needs a headed window) — close old context
    try { await contextCache.context.close() } catch (_) { /* ignore */ }
    contextCache = null
  }

  await fs.mkdir(PROFILE_DIR, { recursive: true })
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    args: BROWSER_ARGS,
    userAgent: CHROME_UA,
    locale: 'en-US',
    viewport: { width: 1300, height: 900 },
  })
  context.on('close', () => {
    if (contextCache && contextCache.context === context) contextCache = null
  })
  try {
    await context.addCookies(CONSENT_COOKIES)
  } catch (_) { /* ignore */ }

  contextCache = { context, headless }
  return context
}

async function closeBrowser() {
  if (contextCache) {
    try { await contextCache.context.close() } catch (_) { /* ignore */ }
    contextCache = null
  }
}

function watchUrl(video_id, hl) {
  return `https://www.youtube.com/watch?v=${video_id}&hl=${hl}&gl=US`
}

async function newPage(context) {
  const page = await context.newPage()
  page.setDefaultTimeout(config.navTimeoutMs)
  return page
}

// Click through the consent interstitial if it appears despite the cookies
async function dismissConsent(page) {
  try {
    if (page.url().includes('consent.youtube.com') || page.url().includes('consent.google.net')) {
      const btn = page.locator('button:has-text("Accept all"), button:has-text("Reject all"), button:has-text("Accept the recommended settings")').first()
      await btn.click({ timeout: 5000 })
      await page.waitForLoadState('domcontentloaded')
    }
  } catch (_) { /* not on a consent page, ignore */ }
}

// Detect YouTube's anti-bot wall so the error message is actionable
async function checkBotCheck(page) {
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
  if (/Sign in to confirm you.re not a bot/i.test(body)) {
    return "Error fetching subtitle: YouTube is showing a bot check (\"Sign in to confirm you're not a bot\"). Use the login-youtube-browser tool to open a real browser window and sign in to YouTube once; the session is saved in the persistent profile."
  }
  return null
}

// Port of the bookmarklet: direct DOM click on the "Show transcript" chip
// (Playwright's actionability-checked click times out because the chip sits
// inside the collapsed description), then scrape the panel's DOM.
async function scrapeTranscript(page) {
  // The chip is rendered by the JS app after hydration — wait for it to exist
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="Show transcript"]') ||
    document.querySelector('ytd-video-description-transcript-section-renderer button'),
    null,
    { timeout: config.panelTimeoutMs }
  ).catch(() => {})

  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Show transcript"]') ||
      document.querySelector('ytd-video-description-transcript-section-renderer button')
    if (!el) return false
    el.click()
    return true
  })
  if (!clicked) {
    return { title: null, segments: [], error: "Transcript button not found. The video may have no captions, or the page layout is unexpected." }
  }

  // Wait for the panel to render segments (new view model or classic renderer)
  await page.waitForSelector(
    'transcript-segment-view-model, ytd-transcript-segment-renderer',
    { timeout: config.panelTimeoutMs }
  )

  return page.evaluate(() => {
    const titleEl = document.querySelector('h1 yt-formatted-string') ||
      document.querySelector('h1.style-scope.ytd-watch-metadata') ||
      document.querySelector('h1')
    const title = (titleEl ? titleEl.textContent : document.title)
      .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/ - YouTube$/, '')

    const segments = []

    // Newer transcript view model (as used by the bookmarklet)
    document.querySelectorAll('transcript-segment-view-model').forEach(el => {
      const ts = el.querySelector('.ytwTranscriptSegmentViewModelTimestamp')?.textContent.trim()
      const tx = el.querySelector('.ytAttributedStringHost')?.textContent.trim()
      if (ts && tx) segments.push([ts, tx])
    })

    // Classic transcript renderer (older YouTube layout)
    if (segments.length === 0) {
      document.querySelectorAll('ytd-transcript-segment-renderer').forEach(el => {
        const ts = el.querySelector('.segment-timestamp')?.textContent.trim()
        const tx = el.querySelector('.segment-text')?.textContent.trim()
        if (ts && tx) segments.push([ts, tx])
      })
    }

    return { title, segments }
  })
}

// ── MCP server ───────────────────────────────────────────────────────────────
// The SDK forbids connecting one McpServer instance to a second transport, so
// HTTP mode creates a fresh server + transport per request (stateless mode).
// Tools are stateless: they share the module-level browser queue, cache, config.
function createServer() {
  const server = new McpServer({
    name: config.name,
    version: config.version,
  })

  server.registerTool(
    "get-youtube-video-transcript-and-title",
    {
      title: "Get Youtube Video Transcript and Title",
      description: `Get transcript with timestamps and title from a youtube video using a headless browser. In stdio mode, responses longer than ${Math.round(CHUNK_SIZE / 1024)} KB are split into chunks. If the response starts with '--- Part 1/', call this tool again with chunk=2, chunk=3, etc. to get the remaining parts.`,
      inputSchema: {
        video_id: z.string().regex(YOUTUBE_VIDEO_ID_REGEX, "Invalid YouTube video ID format"),
        lang: z.string().regex(VALID_LANG_CODES, "Invalid language code format"),
        chunk: z.number().int().min(1).optional().default(1)
      }
    },
    async ({video_id, lang, chunk}) => {
      if (mode === 'stdio') {
        return await handle_chunked_subtitle(video_id, lang, chunk)
      }
      return {
        content: [{
          type: "text",
          text: await fetch_subtitle(video_id, lang)
        }]
      }
    }
  )

  server.registerTool(
    "get-youtube-video-comments",
    {
      title: "Get Youtube Video Comments",
      description: "Get comments from a youtube video using a headless browser",
      inputSchema: {
        video_id: z.string().regex(YOUTUBE_VIDEO_ID_REGEX, "Invalid YouTube video ID format"),
        sortby: z.enum(VALID_SORT_OPTIONS, "sortby must be 'top' or 'newest'"),
        max_comments: z.number().int().min(1).max(1000, "max_comments must not exceed 1000")
      }
    },
    async ({video_id, sortby, max_comments}) => ({
      content: [{
        type: "text",
        text: await fetch_comments(video_id, sortby, max_comments)
      }]
    })
  )

  server.registerTool(
    "login-youtube-browser",
    {
      title: "Login to YouTube in Browser",
      description: "Open a visible browser window with the MCP's persistent profile so the user can sign in to YouTube once. The session is saved and used to defeat bot checks in subsequent headless fetches. Blocks until the user closes the browser window.",
    },
    async () => ({
      content: [{
        type: "text",
        text: await login_youtube()
      }]
    })
  )

  return server
}

async function handle_chunked_subtitle(video_id, lang, chunk) {
  await ensureCacheDir()
  const cachePath = getCachePath(video_id, lang)

  // Try cache first
  let cached = await readCache(cachePath)
  if (cached) {
    const fullText = cached.text
    if (fullText.length <= CHUNK_SIZE) {
      return { content: [{ type: "text", text: fullText }] }
    }
    const chunks = splitIntoChunks(fullText, video_id)
    if (chunk > chunks.length) {
      return { content: [{ type: "text", text: `Chunk ${chunk} out of range (1-${chunks.length} available).` }] }
    }
    return { content: [{ type: "text", text: chunks[chunk - 1] }] }
  }

  // Not cached — fetch full transcript
  const fullText = await fetch_subtitle(video_id, lang)

  // Don't cache errors
  if (fullText.startsWith("Error") || fullText === "No transcript available.") {
    return { content: [{ type: "text", text: fullText }] }
  }

  // Store in cache
  await writeCache(cachePath, fullText)

  // If short enough, return as-is
  if (fullText.length <= CHUNK_SIZE) {
    return { content: [{ type: "text", text: fullText }] }
  }

  // Split and return requested chunk
  const chunks = splitIntoChunks(fullText, video_id)
  if (chunk > chunks.length) {
    return { content: [{ type: "text", text: `Chunk ${chunk} out of range (1-${chunks.length} available).` }] }
  }
  return { content: [{ type: "text", text: chunks[chunk - 1] }] }
}

async function fetch_subtitle(video_id, lang = "en") {
  return serialize(async () => {
    let page
    try {
      const context = await getContext(true)
      page = await newPage(context)

      await page.goto(watchUrl(video_id, lang), { waitUntil: 'domcontentloaded' })
      await dismissConsent(page)

      const botCheck = await checkBotCheck(page)
      if (botCheck) return botCheck

      const { title, segments, error } = await scrapeTranscript(page)
      if (error) return "Error fetching subtitle: " + error
      if (!segments || segments.length === 0) return "No transcript available."

      const timestampedText = segmentsToTimestampedText(segments)
      return `title: ${title}\n\n${timestampedText}`
    } catch (err) {
      return "Error fetching subtitle: " + (err.message || 'Unknown error occurred')
    } finally {
      if (page) { try { await page.close() } catch (_) {} }
    }
  })
}

async function fetch_comments(video_id, sortby = "top", max_comments = 30) {
  return serialize(async () => {
    let page
    try {
      const context = await getContext(true)
      page = await newPage(context)

      // hl=en keeps the sort menu labels predictable
      await page.goto(watchUrl(video_id, 'en'), { waitUntil: 'domcontentloaded' })
      await dismissConsent(page)

      const botCheck = await checkBotCheck(page)
      if (botCheck) return botCheck

      // New layout: comments are collapsed behind a "Comments" chip in the description.
      // The chip is rendered by the JS app after hydration — wait for it to exist.
      await page.waitForFunction(() =>
        document.querySelector('ytd-video-description-comments-section-renderer button') ||
        document.querySelector('[aria-label="Comments"]') ||
        document.querySelector('#comments-button'),
        null,
        { timeout: config.panelTimeoutMs }
      ).catch(() => {})

      await page.evaluate(() => {
        const el = document.querySelector('ytd-video-description-comments-section-renderer button') ||
          document.querySelector('[aria-label="Comments"]') ||
          document.querySelector('#comments-button')
        el?.click()
      })

      // Wait for the first comment threads to render
      await page.waitForSelector('ytd-comment-thread-renderer', { timeout: config.panelTimeoutMs }).catch(() => {})

      // Apply sort order via the "Sort comments" dropdown
      const sortButton = page.locator('ytd-comments [aria-label="Sort comments"], ytd-comments #sort-button').first()
      if (await sortButton.count().catch(() => 0)) {
        await sortButton.click({ timeout: 5000 }).catch(() => {})
        const target = sortby === 'top' ? 'Top comments' : 'Newest first'
        await page.locator(`ytd-menu-service-item-renderer:has-text("${target}")`).first()
          .click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(2000)
      }

      const collected = []
      const seen = new Set()
      let lastCount = 0
      let stalls = 0

      while (collected.length < max_comments && stalls < 5) {
        const batch = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('ytd-comment-thread-renderer')).map(el => {
            const author = (el.querySelector('#author-text') || el.querySelector('.author-text'))?.textContent.trim()
            const text = el.querySelector('#content-text')?.textContent.trim()
            const when = (el.querySelector('#published-time-text') || el.querySelector('.published-time-text'))?.textContent.trim()
            // New layout exposes the like count in the like button's aria-label
            const likeLabel = el.querySelector('button[aria-label^="Like this comment"]')?.getAttribute('aria-label') || ''
            const likeMatch = likeLabel.match(/along with ([\d.,KkMm]+) other people/)
            const likes = likeMatch ? likeMatch[1] : (el.querySelector('.like-button-count')?.textContent.trim() || '')
            return { author, when, likes, text, key: `${author}|${text}` }
          }).filter(c => c.text)
        })

        for (const c of batch) {
          if (!seen.has(c.key)) {
            seen.add(c.key)
            collected.push(c)
          }
        }
        if (collected.length >= max_comments) break

        // "Show more" button loads the next batch of comments
        const more = page.locator('ytd-comments button[aria-label="Show more"], ytd-comments #more-button').last()
        if (await more.count().catch(() => 0)) {
          await more.click({ timeout: 5000 }).catch(() => {})
        }
        await page.locator('ytd-comments').scrollIntoViewIfNeeded().catch(() => {})
        await page.waitForTimeout(1500)

        if (collected.length === lastCount) stalls++
        else stalls = 0
        lastCount = collected.length
      }

      if (collected.length === 0) return "No comments available."

      const limited = collected.slice(0, max_comments)
      const blocks = limited.map((c, i) => {
        const lines = [`--- Comment ${i + 1} ---`]
        if (c.author) lines.push(`author: ${c.author}`)
        if (c.when) lines.push(`time: ${c.when}`)
        if (c.likes) lines.push(`likes: ${c.likes}`)
        lines.push(`text: ${c.text}`)
        return lines.join('\n')
      })
      return blocks.join('\n\n')
    } catch (err) {
      // Suppress stderr by default
      return "Error fetching comments: " + (err.message || 'Unknown error occurred')
    } finally {
      if (page) { try { await page.close() } catch (_) {} }
    }
  })
}

async function login_youtube() {
  return serialize(async () => {
    try {
      // getContext closes any cached headless context first: a persistent
      // profile can only be opened by one browser process at a time
      const context = await getContext(false)
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' }).catch(() => {})

      // Block until the user closes the browser window
      await new Promise(resolve => context.on('close', resolve))
      return `Browser closed. YouTube session saved to persistent profile at ${PROFILE_DIR}`
    } catch (err) {
      return "Login failed: " + (err.message || 'Unknown error occurred')
    }
  })
}

// ── Stdio transport ──────────────────────────────────────────────────────────
async function serve_stdio() {
  await cleanCache()
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// ── HTTP transport ───────────────────────────────────────────────────────────
let activeHttpServer = null

function serve_http(port) {
  const httpServer = http.createServer(async (req, res) => {
    const timestamp = new Date().toISOString()
    if (req.url === '/mcp' || req.url === '/mcp/') {
      let parsedBody
      if (['POST', 'PUT'].includes(req.method)) {
        parsedBody = await parseBody(req)
      }
      if (parsedBody) {
        const { method, params } = parsedBody
        if (params && Object.keys(params).length > 0) {
          const paramStr = Object.entries(params).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ')
          console.log(`${timestamp} ${method} {${paramStr}}`)
        } else {
          console.log(`${timestamp} ${method} (no params)`)
        }
      } else {
        console.log(`${timestamp} ${req.method} ${req.url}`)
      }
      const originalEnd = res.end.bind(res)
      res.end = function (chunk, ...args) {
        if (chunk) {
          const size = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
          console.log(`Response size: ${formatBytes(size)}`)
        }
        return originalEnd(chunk, ...args)
      }
      // Stateless mode: the SDK requires a fresh server + transport per request,
      // so concurrent requests never touch the same Protocol instance.
      const server = createServer()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, parsedBody)
    } else {
      console.log(`${timestamp} ${req.method} ${req.url}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  httpServer.listen(port, () => {
    console.log('MCP server listening on port ' + port)
  })

  activeHttpServer = httpServer
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown() {
  console.log('\nShutting down...')
  const finish = () => process.exit(0)
  closeBrowser().catch(() => {}).then(() => {
    if (activeHttpServer) {
      activeHttpServer.close(() => {
        console.log('HTTP server closed.')
        finish()
      })
      // Force close after 5 seconds
      setTimeout(finish, 5000)
    } else {
      finish()
    }
  })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

// ── Start server ─────────────────────────────────────────────────────────────
if (mode === 'http') {
  serve_http(port)
} else {
  serve_stdio()
}
