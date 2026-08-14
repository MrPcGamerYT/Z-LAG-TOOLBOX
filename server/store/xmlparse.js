'use strict';

/**
 * Tiny, dependency-free, fault-tolerant XML reader.
 *
 * The FE3 SyncUpdates answer is a SOAP envelope that carries *escaped* XML
 * fragments inside <Xml> elements. Once unescaped the document is a normal
 * tree, and the only way to pair a package file name with the UpdateID that
 * can produce its download link is to walk that tree — exactly what
 * Alt App Installer does with minidom and what StoreLib does with
 * XmlDocument.
 *
 * The previous implementation split the response on "<UpdateInfo" and hoped
 * the <File> tag and the <UpdateIdentity> tag lived in the same chunk. They
 * do not: <SecuredFragment> / <UpdateIdentity> live under <NewUpdates>, while
 * <Files><File> lives further down under <ExtendedUpdateInfo>. The two are
 * joined by a shared <ID>. Pairing them positionally produced a file name
 * bolted onto somebody else's UpdateID, and GetExtendedUpdateInfo2 then
 * answered with an empty <FileLocation> list — the
 * "Microsoft did not return a download link for this package" error.
 *
 * Only what we need is implemented: elements, attributes, text, comments,
 * CDATA and processing instructions. Unbalanced or stray closing tags are
 * tolerated instead of throwing, because escaped payloads (JSON blobs,
 * localized descriptions) can contain markup-looking text.
 */

class XmlNode {
  constructor(tag, attrs, parent) {
    this.tag = tag;               // local name, namespace prefix stripped
    this.rawTag = tag;
    this.attrs = attrs || {};
    this.parent = parent || null;
    this.children = [];
    this.textParts = [];
  }

  /** Direct element children, optionally filtered by local name. */
  childElements(name) {
    if (!name) return this.children;
    const want = String(name).toLowerCase();
    return this.children.filter((c) => c.tag.toLowerCase() === want);
  }

  firstChild(name) {
    return this.childElements(name)[0] || null;
  }

  /** All descendants with this local name, document order. */
  getElementsByTagName(name) {
    const want = String(name).toLowerCase();
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tag.toLowerCase() === want) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  attr(name) {
    const want = String(name).toLowerCase();
    for (const k of Object.keys(this.attrs)) {
      if (k.toLowerCase() === want) return this.attrs[k];
    }
    return '';
  }

  /** Concatenated text of this node and everything under it. */
  get text() {
    let s = this.textParts.join('');
    for (const c of this.children) s += c.text;
    return s;
  }

  /** Text of this node only, trimmed — enough for <ID>42</ID>. */
  get ownText() {
    return this.textParts.join('').trim();
  }

  /** Nearest ancestor (or self) carrying this local name. */
  closest(name) {
    const want = String(name).toLowerCase();
    let n = this;
    while (n) {
      if (n.tag.toLowerCase() === want) return n;
      n = n.parent;
    }
    return null;
  }
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"'
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (m, ent) => {
    const key = ent.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (!isNaN(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch (_) { return m; }
      }
    }
    return m;
  });
}

function localName(tag) {
  const i = tag.indexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

function parseAttrs(chunk) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(chunk))) {
    attrs[localName(m[1])] = decodeEntities(m[3] != null ? m[3] : (m[4] || ''));
  }
  return attrs;
}

/**
 * @param {string} text  XML document
 * @returns {XmlNode} synthetic root whose children are the top level elements
 */
function parseXml(text) {
  const src = String(text || '');
  const root = new XmlNode('#document', {}, null);
  let current = root;
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      current.textParts.push(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) current.textParts.push(decodeEntities(src.slice(i, lt)));

    // <!-- comment -->  /  <![CDATA[ ... ]]>  /  <!DOCTYPE ...>
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const body = src.slice(lt + 9, end === -1 ? src.length : end);
      current.textParts.push(body);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const gt = src.indexOf('>', lt + 1);
    if (gt === -1) {
      current.textParts.push(decodeEntities(src.slice(lt)));
      break;
    }
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;
    if (!inner.trim()) continue;

    if (inner[0] === '/') {
      // Closing tag — climb to the matching ancestor, ignore strays.
      const name = localName(inner.slice(1).trim()).toLowerCase();
      let n = current;
      while (n && n !== root && n.tag.toLowerCase() !== name) n = n.parent;
      if (n && n !== root) current = n.parent || root;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^([A-Za-z_:][-A-Za-z0-9_:.]*)/);
    if (!nameMatch) continue;
    const raw = nameMatch[1];
    const node = new XmlNode(localName(raw), parseAttrs(body.slice(raw.length)), current);
    node.rawTag = raw;
    current.children.push(node);
    if (!selfClosing) current = node;
  }

  return root;
}

module.exports = { parseXml, XmlNode, decodeEntities };
