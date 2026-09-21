'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ZEN_HOST = process.env.ZEN_HOST || 'opencode.ai';
const ZEN_PREFIX = process.env.ZEN_PREFIX || '/zen/v1';
// Use a separate default from commandcode-proxy, which commonly occupies 8787.
const PORT = parseInt(process.env.BRIDGE_PORT || '8788', 10);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const SESSION_ID = process.env.OPENCODE_SESSION_ID || ('opencode-bridge-' + crypto.randomBytes(8).toString('hex'));
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4-flash-free';
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS || 'muse-spark-1.3-contributor-free,mimo-v2.5-free,ling-3.0-flash-fin-free,nemotron-3-ultra-free,big-pickle')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_FREE_MODELS = [
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'mimo-v2.5-free',
  'big-pickle'
];

let cachedKey = null;
const LOG_FILE = path.join(__dirname, 'bridge.log');

function log() {
  const line = new Date().toISOString() + '  ' + Array.prototype.join.call(arguments, ' ');
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {}
  console.log(line);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function authFileCandidates() {
  const list = [];
  if (process.env.OPENCODE_AUTH_FILE) list.push(process.env.OPENCODE_AUTH_FILE);
  list.push(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
  if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'opencode', 'auth.json'));
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'));
  return list;
}

function getKey() {
  if (process.env.OPENCODE_ZEN_KEY) return process.env.OPENCODE_ZEN_KEY;
  if (cachedKey) return cachedKey;
  for (const file of authFileCandidates()) {
    try {
      const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (auth.opencode && auth.opencode.key) {
        cachedKey = auth.opencode.key;
        return cachedKey;
      }
    } catch (e) {}
  }
  return null;
}

async function zenRequest(method, pathname, headers, body) {
  const key = getKey();
  const h = Object.assign({
    'Authorization': 'Bearer ' + (key || 'missing-key'),
    'x-session-id': SESSION_ID
  }, headers || {});
  const res = await fetch('https://' + ZEN_HOST + ZEN_PREFIX + pathname, {
    method: method,
    headers: h,
    body: body != null ? body : undefined
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const respHeaders = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });
  return { statusCode: res.status, headers: respHeaders, body: buf };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json',
    'Content-Length': body.length
  }, corsHeaders()));
  res.end(body);
}

function sse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function normalizeModel(model) {
  let m = String(model || DEFAULT_MODEL);
  if (m.startsWith('opencode/')) m = m.slice('opencode/'.length);
  if (m.startsWith('zen/')) m = m.slice('zen/'.length);
  return m;
}

let validModels = null;

async function refreshModels() {
  try {
    const upstream = await zenRequest('GET', '/models', { 'Accept': 'application/json' }, null);
    if (upstream.statusCode === 200) {
      const j = JSON.parse(upstream.body.toString());
      const ids = (j.data || []).map(x => x.id).filter(Boolean);
      if (ids.length) validModels = new Set(ids);
    }
  } catch (e) {}
  return validModels;
}

function resolveModel(model) {
  const m = normalizeModel(model);
  if (validModels && !validModels.has(m)) {
    log('[model] unknown "' + m + '" -> fallback "' + DEFAULT_MODEL + '"');
    return DEFAULT_MODEL;
  }
  return m;
}

async function listModels() {
  if (validModels && validModels.size) return Array.from(validModels);
  const refreshed = await refreshModels();
  if (refreshed && refreshed.size) return Array.from(refreshed);
  return DEFAULT_FREE_MODELS;
}

function buildChain(primary) {
  const chain = [];
  for (const m of [primary, DEFAULT_MODEL].concat(FALLBACK_MODELS)) {
    const n = normalizeModel(m);
    if (n && chain.indexOf(n) === -1) chain.push(n);
  }
  return chain;
}

function extractUpstreamError(oai) {
  if (oai && oai.error) {
    const e = oai.error;
    return typeof e === 'string' ? e : (e.message || JSON.stringify(e));
  }
  return null;
}

function hasVisibleOutput(oai) {
  const choice = oai && oai.choices && oai.choices[0];
  const msg = choice && choice.message;
  if (!msg) return false;
  if (typeof msg.content === 'string' && msg.content.trim().length) return true;
  if (Array.isArray(msg.content) && msg.content.length) return true;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
  return false;
}

async function zenChatValidated(oaiReq) {
  const chain = buildChain(oaiReq.model);
  let last = null;
  for (const model of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reqBody = Object.assign({}, oaiReq, { model: model, stream: false });
      let upstream;
      try {
        upstream = await zenRequest('POST', '/chat/completions', {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }, Buffer.from(JSON.stringify(reqBody)));
      } catch (e) {
        last = { status: 0, message: e.message };
        log('[retry] ' + model + ' -> network ' + e.message);
        await sleep(300);
        continue;
      }
      const buf = upstream.body;
      let oai;
      try {
        oai = JSON.parse(buf.toString());
      } catch (e) {
        last = { status: upstream.statusCode, message: 'bad upstream json' };
        log('[retry] ' + model + ' -> bad json');
        await sleep(300);
        continue;
      }
      const err = extractUpstreamError(oai);
      if (upstream.statusCode >= 400 || err) {
        last = { status: upstream.statusCode, message: err || ('status ' + upstream.statusCode) };
        log('[retry] ' + model + ' (try ' + attempt + ') -> ' + last.status + ' ' + String(last.message).slice(0, 140));
        if (upstream.statusCode === 403 || upstream.statusCode === 401) break;
        await sleep(300);
        continue;
      }
      if (!hasVisibleOutput(oai)) {
        last = { status: 200, message: 'empty response' };
        log('[retry] ' + model + ' (try ' + attempt + ') -> empty response');
        await sleep(300);
        continue;
      }
      const _m = (oai.choices && oai.choices[0] && oai.choices[0].message) || {};
      log('[ok] ' + model + ' contentLen=' + (typeof _m.content === 'string' ? _m.content.length : 0) + ' tools=' + ((_m.tool_calls || []).length));
      return { oai: oai, model: model };
    }
  }
  return { error: last || { status: 502, message: 'all models failed' } };
}

function mapStopReason(reason) {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(b => (typeof b === 'string' ? b : (b && b.text) || '')).filter(Boolean).join('\n');
  }
  return '';
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'string' ? b : (b && b.text) || '')).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

function anthropicToOpenAI(a) {
  const messages = [];
  const systemText = systemToText(a.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const msg of (a.messages || [])) {
    if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      const content = msg.content;
      if (typeof content === 'string') {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block) continue;
          if (block.type === 'text') textParts.push(block.text || '');
          else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
            });
          }
        }
      }
      const m = { role: 'assistant', content: textParts.join('') || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      messages.push(m);
      continue;
    }

    const content = msg.content;
    if (typeof content === 'string') {
      messages.push({ role: 'user', content });
      continue;
    }
    const textParts = [];
    const toolResults = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text') textParts.push(block.text || '');
        else if (block.type === 'tool_result') {
          toolResults.push({ id: block.tool_use_id, text: toolResultText(block.content) });
        }
      }
    }
    if (textParts.length) messages.push({ role: 'user', content: textParts.join('') });
    for (const tr of toolResults) {
      messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.text });
    }
    if (!textParts.length && !toolResults.length) messages.push({ role: 'user', content: '' });
  }

  const out = { model: resolveModel(a.model), messages, stream: false };
  if (a.max_tokens != null) out.max_tokens = a.max_tokens;
  if (a.temperature != null) out.temperature = a.temperature;
  if (a.top_p != null) out.top_p = a.top_p;
  if (a.stop_sequences) out.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    out.tools = a.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  }
  if (a.tool_choice) {
    const tc = a.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return out;
}

function openAIToAnthropic(oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch (e) {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id || ('toolu_' + crypto.randomBytes(8).toString('hex')),
        name: (tc.function && tc.function.name) || '',
        input
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const usage = oai.usage || {};
  return {
    id: 'msg_' + (oai.id || crypto.randomBytes(12).toString('hex')),
    type: 'message',
    role: 'assistant',
    model: model,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    }
  };
}

function emitOpenAIStream(res, oai, model) {
  const id = oai.id || ('chatcmpl-' + crypto.randomBytes(8).toString('hex'));
  const created = oai.created || Math.floor(Date.now() / 1000);
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const chunk = (delta, finish) => {
    res.write('data: ' + JSON.stringify({
      id: id,
      object: 'chat.completion.chunk',
      created: created,
      model: model,
      choices: [{ index: 0, delta: delta, finish_reason: finish || null }]
    }) + '\n\n');
  };
  chunk({ role: 'assistant', content: '' });
  if (msg.content) chunk({ content: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    chunk({
      tool_calls: msg.tool_calls.map((tc, i) => ({
        index: i,
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function && tc.function.name,
          arguments: tc.function && tc.function.arguments
        }
      }))
    });
  }
  chunk({}, choice.finish_reason || 'stop');
  res.write('data: [DONE]\n\n');
}

function emitAnthropicStream(res, oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const usage = oai.usage || {};
  const msgId = 'msg_' + (oai.id || crypto.randomBytes(12).toString('hex'));

  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0 }
    }
  });

  let index = 0;
  if (msg.content) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: index, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: index, delta: { type: 'text_delta', text: msg.content } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: index });
    index++;
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const id = tc.id || ('toolu_' + crypto.randomBytes(8).toString('hex'));
      const name = (tc.function && tc.function.name) || '';
      const args = (tc.function && tc.function.arguments) || '{}';
      sse(res, 'content_block_start', { type: 'content_block_start', index: index, content_block: { type: 'tool_use', id: id, name: name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: index, delta: { type: 'input_json_delta', partial_json: args } });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: index });
      index++;
    }
  }
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(choice.finish_reason), stop_sequence: null },
    usage: { output_tokens: usage.completion_tokens || 0 }
  });
  sse(res, 'message_stop', { type: 'message_stop' });
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch (e) {
    return sendJson(res, 400, { error: { message: 'invalid json body' } });
  }
  payload.model = resolveModel(payload.model);
  const wantsStream = !!payload.stream;
  const r = await zenChatValidated(payload);
  if (r.error) {
    return sendJson(res, 502, { error: { message: r.error.message } });
  }
  if (wantsStream) {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }, corsHeaders()));
    emitOpenAIStream(res, r.oai, r.model);
    return res.end();
  }
  return sendJson(res, 200, r.oai);
}

async function handleAnthropicMessages(req, res) {
  const raw = await readBody(req);
  let a;
  try {
    a = JSON.parse(raw.toString());
  } catch (e) {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid json body' } });
  }

  const oaiReq = anthropicToOpenAI(a);
  const wantsStream = !!a.stream;

  try {
    const lastUser = (a.messages || []).filter(m => m.role === 'user').slice(-1)[0];
    let lastText = '';
    if (lastUser) {
      const c = lastUser.content;
      if (typeof c === 'string') lastText = c;
      else if (Array.isArray(c)) lastText = c.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
    }
    log('[anthropic] model=' + a.model + ' msgs=' + (a.messages || []).length + ' tools=' + ((a.tools || []).length) + ' lastUser="' + String(lastText).replace(/\s+/g, ' ').slice(0, 120) + '"');
  } catch (e) {}

  const r = await zenChatValidated(oaiReq);
  if (r.error) {
    if (wantsStream) {
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }, corsHeaders()));
      sse(res, 'error', { type: 'error', error: { type: 'api_error', message: r.error.message } });
      return res.end();
    }
    return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: r.error.message } });
  }

  if (wantsStream) {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }, corsHeaders()));
    emitAnthropicStream(res, r.oai, a.model);
    return res.end();
  }
  return sendJson(res, 200, openAIToAnthropic(r.oai, a.model));
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (p === '/health') {
        return sendJson(res, 200, {
          status: 'ok',
          session: SESSION_ID,
          hasKey: !!getKey(),
          default: DEFAULT_MODEL,
          proxy: process.env.NODE_USE_ENV_PROXY ? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'enabled') : 'direct',
          upstream: 'https://' + ZEN_HOST + ZEN_PREFIX
        });
      }

      if (p === '/v1/models' && req.method === 'GET') {
        const ids = await listModels();
        return sendJson(res, 200, {
          object: 'list',
          data: ids.map(id => ({ id: 'opencode/' + id, object: 'model', created: 0, owned_by: 'opencode' }))
        });
      }

      if (p === '/v1/chat/completions' && req.method === 'POST') {
        return handleChatCompletions(req, res);
      }

      if (p === '/v1/messages' && req.method === 'POST') {
        return handleAnthropicMessages(req, res);
      }

      sendJson(res, 404, { error: { message: 'not found: ' + p } });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
      else res.end();
    }
  });
}

function start() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const key = getKey();
    console.log('');
    console.log('  OpenCode Free Model Bridge');
    console.log('  -----------------------------------------');
    console.log('  Listening : http://' + HOST + ':' + PORT);
    console.log('  OpenAI    : http://' + HOST + ':' + PORT + '/v1/chat/completions');
    console.log('  Anthropic : http://' + HOST + ':' + PORT + '/v1/messages');
    console.log('  Models    : http://' + HOST + ':' + PORT + '/v1/models');
    console.log('  Default   : ' + DEFAULT_MODEL);
    console.log('  Fallbacks : ' + FALLBACK_MODELS.join(', '));
    console.log('  Zen key   : ' + (key ? 'loaded' : 'NOT FOUND (run: opencode auth login)'));
    console.log('  -----------------------------------------');
    console.log('');
    refreshModels();
    setInterval(refreshModels, 10 * 60 * 1000).unref();
  });
  return server;
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  normalizeModel,
  zenRequest,
  streamToBuffer,
  start
};

if (require.main === module) {
  start();
}
