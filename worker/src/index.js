// Broken to Peace admin editor backend.
// Runs at brokentopeacefoundation.org/api/*, gated by Cloudflare Access.
// Uses a GitHub PAT stored in Worker secrets to commit edits to the repo.

const OWNER = 'faithjtherapy';
const REPO = 'brokentopeacefoundation';
const BRANCH = 'main';
const CORS = {
  'Access-Control-Allow-Origin': 'https://brokentopeacefoundation.org',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, cf-access-jwt-assertion',
  'Access-Control-Max-Age': '86400',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

async function ghFetch(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'btp-admin-worker',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getFile(path, token) {
  return ghFetch(
    `/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}&t=${Date.now()}`,
    token
  );
}

async function putFile(path, contentB64, sha, message, token) {
  return ghFetch(`/repos/${OWNER}/${REPO}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify({ message, content: contentB64, sha, branch: BRANCH }),
  });
}

// UTF-8 safe base64 encode
function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64Decode(b) {
  const bin = atob(b.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Replace text content of matching elements in an HTML string using regex-guided splits.
// We use HTMLRewriter for structural edits since Workers has it built in.
async function replaceParagraphs(html, selector, values) {
  const results = [];
  let idx = 0;
  const rewriter = new HTMLRewriter().on(selector, {
    element(el) {
      const v = values[idx];
      idx++;
      if (typeof v === 'string' && v.length) {
        el.setInnerContent(v, { html: false });
      }
    },
  });
  const res = rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html' } }));
  return await res.text();
}

async function replaceServices(html, cards) {
  // cards = [{title, body}, ...]
  let cardIdx = 0;
  const rewriter = new HTMLRewriter()
    .on('#services .value', {
      element() {
        // capture card index for children
        this._i = cardIdx;
        cardIdx++;
      },
    });
  // Simpler: separate scans for h3 and p under #services .value
  let hIdx = 0, pIdx = 0;
  const rewriter2 = new HTMLRewriter()
    .on('#services .value h3', {
      element(el) {
        const c = cards[hIdx]; hIdx++;
        if (c && c.title) el.setInnerContent(c.title, { html: false });
      },
    })
    .on('#services .value p', {
      element(el) {
        const c = cards[pIdx]; pIdx++;
        if (c && c.body) el.setInnerContent(c.body, { html: false });
      },
    });
  const res = rewriter2.transform(new Response(html, { headers: { 'content-type': 'text/html' } }));
  return await res.text();
}

async function replaceBio(html, paragraphs) {
  let idx = 0;
  const rewriter = new HTMLRewriter().on('.founder-copy > p', {
    element(el) {
      const v = paragraphs[idx];
      idx++;
      if (typeof v === 'string' && v.length) {
        el.setInnerContent(v, { html: false });
      }
    },
  });
  const res = rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html' } }));
  return await res.text();
}

async function commitIndex(env, modify, message) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN secret not set on this Worker');
  const file = await getFile('index.html', token);
  const html = b64Decode(file.content);
  const newHtml = await modify(html);
  return putFile('index.html', b64Encode(newHtml), file.sha, message, token);
}

async function commitPhoto(env, contentB64) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN secret not set on this Worker');
  const file = await getFile('IMG_0496.png', token);
  return putFile(
    'IMG_0496.png',
    contentB64,
    file.sha,
    'Admin editor: update founder photo',
    token
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Cloudflare Access JWT presence check (belt & suspenders — Access rule already gates the path)
    const jwt = request.headers.get('cf-access-jwt-assertion');
    if (!jwt) return json(401, { error: 'Not authenticated (missing Access JWT)' });

    try {
      if (url.pathname === '/api/save-bio' && request.method === 'POST') {
        const { paragraphs } = await request.json();
        if (!Array.isArray(paragraphs) || paragraphs.length !== 6) {
          return json(400, { error: 'paragraphs must be an array of 6 strings' });
        }
        await commitIndex(env, (h) => replaceBio(h, paragraphs), 'Admin editor: update founder bio');
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/save-services' && request.method === 'POST') {
        const { cards } = await request.json();
        if (!Array.isArray(cards) || cards.length !== 3) {
          return json(400, { error: 'cards must be an array of 3 {title, body}' });
        }
        await commitIndex(env, (h) => replaceServices(h, cards), 'Admin editor: update services');
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/save-photo' && request.method === 'POST') {
        const { contentB64 } = await request.json();
        if (typeof contentB64 !== 'string' || contentB64.length < 100) {
          return json(400, { error: 'contentB64 required' });
        }
        await commitPhoto(env, contentB64);
        return json(200, { ok: true });
      }
      return json(404, { error: 'unknown endpoint' });
    } catch (e) {
      return json(500, { error: e.message || String(e) });
    }
  },
};
