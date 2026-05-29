
(function () {

  /** ---------- OnemindSDK Start ---------- */

class OnemindSDK {
  _widgetId = 'onemind-widget'
  _embedId = 'onemind-embed'

  _sdkErrorCodes = {
    iframeNotFound: 'IFRAME_NOT_FOUND',
    sdkNotReady: 'SDK_NOT_READY',
    targetOriginMissing: 'TARGET_ORIGIN_MISSING',
    targetOriginInvalid: 'TARGET_ORIGIN_INVALID',
    requestTimeout: 'REQUEST_TIMEOUT',
    registerEventFailed: 'REGISTER_EVENT_FAILED',
  }

  _retryableRegistrationErrorCodes = new Set([
    this._sdkErrorCodes.iframeNotFound,
    this._sdkErrorCodes.sdkNotReady,
    this._sdkErrorCodes.targetOriginMissing,
    this._sdkErrorCodes.targetOriginInvalid,
    this._sdkErrorCodes.requestTimeout,
  ])

  _iframeFunctionNames = {
    registerEvent: 'registerEvent',
    sessionContextEvent: 'sessionContextEvent',
    startConversation: 'startConversation',
  }

  _iframeEventNames = {
    conversationStarted: 'conversationStarted',
    conversationEnded: 'conversationEnded',
    chatMessageSent: 'chatMessageSent',
    chatMessageReceived: 'chatMessageReceived',
    actionButtonClicked: 'actionButtonClicked',
    urlClicked: 'urlClicked',
  }

  constructor(config = {}) {
    this.iframeId = config.iframeId || 'onemind-iframe'
    this.targetOrigin = config.targetOrigin
    this.timeoutMs = config.timeout || 15000
    this.registerTimeoutMs = Math.max(config.registerTimeout ?? 3000, 500)
    this.maxRetries = Math.max(config.maxRetries ?? 5, 1)
    this.retryDelayMs = Math.max(config.retryDelay ?? 200, 0)
    this.maxRetryDelayMs = Math.max(config.maxRetryDelay ?? 2000, 0)

    this.iframeWindow = undefined
    this.pendingRequests = new Map()
    this.eventHandlers = new Map()
    this.isListening = false

    this.v1 = {
      onConversationStarted: (callbackFunction) =>
        this._register(this._iframeEventNames.conversationStarted, callbackFunction),
      onConversationEnded: (callbackFunction) =>
        this._register(this._iframeEventNames.conversationEnded, callbackFunction),
      onChatMessageSent: (callbackFunction) => this._register(this._iframeEventNames.chatMessageSent, callbackFunction),
      onChatMessageReceived: (callbackFunction) =>
        this._register(this._iframeEventNames.chatMessageReceived, callbackFunction),
      onActionButtonClicked: (callbackFunction) =>
        this._register(this._iframeEventNames.actionButtonClicked, callbackFunction),
      onUrlClicked: (callbackFunction) => this._register(this._iframeEventNames.urlClicked, callbackFunction),
      sendSessionContextEvent: async (payload) => this._request(this._iframeFunctionNames.sessionContextEvent, payload),
      setWidgetZIndex: (zIndex) => this._setWidgetZIndex(zIndex),
      startConversation: () => this._request(this._iframeFunctionNames.startConversation),
    }
  }

  init() {
    const frame = document.getElementById(this.iframeId)
    if (!frame || !frame.contentWindow) {
      throw this._createError(`onemind: Iframe #${this.iframeId} not found.`, this._sdkErrorCodes.iframeNotFound, { retryable: true })
    }
    this.iframeWindow = frame.contentWindow
    if (!this.targetOrigin && frame.src) {
      try {
        this.targetOrigin = new URL(frame.src).origin
      } catch (e) {
        throw this._createError('onemind: Could not determine targetOrigin from iframe src.', this._sdkErrorCodes.targetOriginInvalid, { retryable: true })
      }
    }
    if (!this.targetOrigin) {
      throw this._createError('onemind: targetOrigin is required for security.', this._sdkErrorCodes.targetOriginMissing, { retryable: true })
    }
    if (!this.isListening) {
      window.addEventListener('message', (event) => this._handleMessage(event))
      this.isListening = true
    }
    return true
  }

  _handleMessage(event) {
    if (event.origin !== this.targetOrigin || event.source !== this.iframeWindow) return
    const { id, method, params, result, error, jsonrpc } = event.data || {}
    if (jsonrpc !== '2.0') return
    if (id && this.pendingRequests.has(id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(id)
      clearTimeout(timer)
      this.pendingRequests.delete(id)
      if (error) {
        const err = new Error(error.message || 'Unknown JSON-RPC Error')
        err.code = error.code
        err.data = error.data
        reject(err)
      } else {
        resolve(result)
      }
      return
    }
    if (method && !id && this.eventHandlers.has(method)) {
      const handler = this.eventHandlers.get(method)
      try { handler(params || {}) } catch (err) { throw new Error(`onemind: Error in event handler for ${method}:`) }
    }
  }

  _request(method, params = [], options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : this.timeoutMs
    if (options.skipInit !== true) {
      try { this.init() } catch (error) { return Promise.reject(error) }
    }
    if (!this.iframeWindow) {
      return Promise.reject(this._createError('onemind: SDK not ready', this._sdkErrorCodes.sdkNotReady, { method, retryable: true }))
    }
    const id = this._generateId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(this._createError(`onemind: Request ${method} timed out`, this._sdkErrorCodes.requestTimeout, { method, retryable: true }))
        }
      }, timeoutMs)
      this.pendingRequests.set(id, { resolve, reject, timer })
      this.iframeWindow.postMessage({ jsonrpc: '2.0', method, params, id }, this.targetOrigin)
    })
  }

  _createError(message, code, options = {}) {
    const error = new Error(message)
    error.code = code
    if (options.cause !== undefined) error.cause = options.cause
    if (options.method !== undefined) error.method = options.method
    if (options.retryable !== undefined) error.retryable = options.retryable
    return error
  }

  _isRetryableRegistrationError(error) {
    if (error && error.code === -32601) return true
    if (!error || typeof error !== 'object') return false
    if (!this._retryableRegistrationErrorCodes.has(error.code)) return false
    if (error.code === this._sdkErrorCodes.requestTimeout) return error.method === this._iframeFunctionNames.registerEvent
    return true
  }

  _delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

  async _register(eventName, handler) {
    if (typeof handler !== 'function') throw new Error('onemind: Handler must be a function')
    let registrationError
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        this.init()
        await this._request(this._iframeFunctionNames.registerEvent, { eventName }, { timeoutMs: this.registerTimeoutMs, skipInit: true })
        this.eventHandlers.set(eventName, handler)
        return
      } catch (error) {
        registrationError = error
        if (this._isRetryableRegistrationError(error) && attempt < this.maxRetries - 1) {
          const delay = Math.min(this.retryDelayMs * Math.pow(2, attempt), this.maxRetryDelayMs)
          await this._delay(delay)
          continue
        }
        break
      }
    }
    throw this._createError('onemind: Failed to register event handler', this._sdkErrorCodes.registerEventFailed, { method: this._iframeFunctionNames.registerEvent, cause: registrationError })
  }

  _unregister(eventName) { return this.eventHandlers.delete(eventName) }
  _generateId() { return crypto.randomUUID() }

  _getWidgetElement() {
    return document.getElementById(this._widgetId) ?? document.getElementById(this._embedId) ?? undefined
  }

  _setWidgetZIndex(zIndex) {
    const widget = this._getWidgetElement()
    if (!widget) throw new Error('onemind: widget is not loaded yet')
    widget.style.setProperty('z-index', zIndex, 'important')
  }
}

if (typeof window !== "undefined") {
  window.onemind = new OnemindSDK();
}

/** ---------- OnemindSDK End ---------- */


/** ---------- Page Context Start ---------- */

const PRUNE_RE = /^(script|style|noscript|template|iframe|object|embed|canvas|svg|source|track|picture|video|audio|meta|link|base)$/i;
const DOM_SETTLE_MS = 300;
const OBSERVE_FOR_MS = 1000;
const DEBOUNCE_MS = 150;

function isValidLocale(candidate) {
  try {
    var canonical = Intl.getCanonicalLocales(candidate)[0];
    if (canonical && !/[-_]/.test(candidate) && candidate.length > 2) return null;
    return canonical ? canonical.split('-')[0].toLowerCase() : null;
  } catch (e) { return null; }
}

function getLocaleFromUrl(url) {
  try {
    const pageUrl = new URL(url);
    const pathParts = pageUrl.pathname.split('/');
    if (pathParts.length > 1) {
      const p = pathParts[1];
      if (/^(?!www$)[a-z]{2,3}(?:-[a-z]{2})?$/i.test(p)) {
        const validated = isValidLocale(p);
        if (validated) return validated;
      }
    }
    const hostParts = pageUrl.hostname.split('.');
    if (hostParts.length > 2) {
      let sub = hostParts[0];
      if (sub.toLowerCase() === 'www' && hostParts.length > 3) sub = hostParts[1];
      if (/^(?!www$)[a-z]{2,3}(?:-[a-z]{2})?$/i.test(sub)) {
        const validated = isValidLocale(sub);
        if (validated) return validated;
      }
    }
  } catch (e) {}
  return null;
}

function debounce(fn, ms) {
  let t;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(null, args); }, ms);
  };
}

function isElementVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el === document.body || el === document.documentElement) return true;
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const cs = getComputedStyle(el);
  if (!cs) return false;
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
  if (el.getClientRects().length === 0) return false;
  return true;
}

function toAbsUrl(href) {
  try { return new URL(href, location.href).toString(); } catch (e) { return ""; }
}

function isHttp(url) {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; } catch (e) { return false; }
}

function stripUTM(url) {
  try {
    const u = new URL(url);
    const drop = { utm_source:1, utm_medium:1, utm_campaign:1, utm_term:1, utm_content:1, gclid:1, fbclid:1, igshid:1, mc_cid:1, mc_eid:1, yclid:1 };
    u.searchParams.forEach(function (_v, k) { if (drop[k]) u.searchParams.delete(k); });
    return u.toString();
  } catch (e) { return url; }
}

const BLOCKS = { p:1,div:1,section:1,article:1,li:1,ul:1,ol:1,pre:1,blockquote:1,table:1,thead:1,tbody:1,tfoot:1,tr:1,td:1,th:1,h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,header:1,footer:1,main:1,aside:1,nav:1 };
const LINEBREAKS = { br:1, hr:1 };

function collectTextWithLinks(node, out) {
  if (!node) return;
  if (node.nodeType === 1) {
    const tag = node.tagName.toLowerCase();
    if (PRUNE_RE.test(tag)) return;
    if (!isElementVisible(node)) return;
    if (BLOCKS[tag]) out.push("\n");
    if (LINEBREAKS[tag]) { out.push("\n"); return; }
    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      let abs = toAbsUrl(href);
      if (isHttp(abs)) {
        abs = stripUTM(abs);
        let text = getVisibleText(node).replace(/\s+/g, " ").trim();
        if (!text) text = abs;
        out.push("[" + text + "](" + abs + ")");
      } else {
        const t2 = getVisibleText(node).replace(/\s+/g, " ").trim();
        if (t2) out.push(t2);
      }
      return;
    }
  }
  if (node.nodeType === 3) { const val = node.nodeValue || ""; if (val.trim()) out.push(val); return; }
  let child = node.firstChild;
  while (child) { collectTextWithLinks(child, out); child = child.nextSibling; }
}

function getVisibleText(el) {
  const buf = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (n.nodeType === 3) return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      if (n.nodeType === 1) {
        const tag = n.tagName.toLowerCase();
        if (PRUNE_RE.test(tag)) return NodeFilter.FILTER_REJECT;
        return isElementVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_REJECT;
    },
  });
  let cur;
  while ((cur = walker.nextNode())) { if (cur.nodeType === 3) buf.push(cur.nodeValue); }
  return buf.join(" ");
}

function extractVisibleTextWithInlineLinks() {
  const root = document.body;
  if (!root) return "";
  const out = [];
  collectTextWithLinks(root, out);
  return out.join("").replace(/[ \t\f\v]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function debounceNav(callback) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(callback, DEBOUNCE_MS); };
}

function onNavigation(callback) {
  try {
    let oldHref = location.href;
    const fire = debounceNav(callback);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { oldHref = location.href; fire(); }, { once: true });
    } else { oldHref = location.href; fire(); }
    window.addEventListener("popstate", function () { if (oldHref !== location.href) { oldHref = location.href; fire(); } });
    window.addEventListener("hashchange", function () { if (oldHref !== location.href) { oldHref = location.href; fire(); } });
    ["pushState", "replaceState"].forEach((type) => {
      const orig = history[type];
      if (typeof orig !== "function") return;
      history[type] = function () {
        const ret = orig.apply(this, arguments);
        if (oldHref !== location.href) { oldHref = location.href; fire(); }
        return ret;
      };
    });
  } catch (e) { console.error("Error in getting page context:", e); }
}

function buildContextPayload() {
  return {
    pageURL: window.location.href,
    pageReferrer: document.referrer || "",
    pageTitle: document.title || "",
    pageTextWithLinks: extractVisibleTextWithInlineLinks(),
    timestamp: new Date().toISOString(),
  };
}

function postPayloadToIframe(payload) {
  const iframe = document.querySelector("#onemind-iframe");
  if (iframe?.contentWindow) iframe.contentWindow.postMessage({ type: "CONTEXT_UPDATE", payload }, "*");
}

function triggerContextUpdate() {
  try {
    setTimeout(function () {
      postPayloadToIframe(buildContextPayload());
      const endAt = Date.now() + OBSERVE_FOR_MS;
      const recapture = debounce(function () { postPayloadToIframe(buildContextPayload()); }, DEBOUNCE_MS);
      const mo = new MutationObserver(function () { if (Date.now() > endAt) { mo.disconnect(); return; } recapture(); });
      mo.observe(document, { subtree: true, childList: true, characterData: true });
      setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, OBSERVE_FOR_MS + 50);
    }, DOM_SETTLE_MS);
  } catch (e) { console.error("Error in getting page context:", e); }
}

onNavigation(triggerContextUpdate);

/** ---------- Page Context END ---------- */

function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)
}

function setCookie(name, value, days) {
  let expires = ""
  if (days) {
    const date = new Date()
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000)
    expires = "; expires=" + date.toUTCString()
  }
  const secureFlag = window.location.protocol === "https:" ? "; Secure" : ""
  document.cookie = name + "=" + (value || "") + expires + "; path=/" + secureFlag + "; SameSite=Lax"
}

function getCookie(name) {
  const nameEQ = name + "="
  const ca = document.cookie.split(';')
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i].trim()
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length)
  }
  return null
}

function getUserParameters() {
  const queryParams = {}
  const params = new URLSearchParams(globalThis.location.search)
  for (const [key, value] of params.entries()) { queryParams['onemind_' + key] = value }

  const locale = getLocaleFromUrl(globalThis.location.href)
  if (locale) {
    queryParams['onemind_user_locale'] = locale
  } else {
    const htmlLangMatch = document.documentElement.lang?.match(/^([a-z]{2,3})(?:-[a-z0-9]+)*$/i)
    if (htmlLangMatch && htmlLangMatch[1].toLowerCase() !== 'en') {
      queryParams['onemind_user_locale'] = htmlLangMatch[1].toLowerCase()
    }
  }
  return queryParams
}

function initializeScript() {
  const run = () => {
    const attributes = {}
    const params = getUserParameters()
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith('onemind_')) attributes[key] = value
    }

    // User token
    let tokenValue = getCookie("om_user_token")
    if (!tokenValue || !isValidUUID(tokenValue)) {
      tokenValue = crypto.randomUUID()
      setCookie("om_user_token", tokenValue, 365)
    }
    attributes['onemind_omusertoken'] = tokenValue

    let url = 'https://launcher.prd-b.1mind.com/v1/launch/w9hv2vz6fn/ai-start?'
    if (attributes['onemind_flow']) url += 'flow=' + encodeURIComponent(attributes['onemind_flow']) + '&'
    for (const key in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        url += encodeURIComponent(key) + '=' + encodeURIComponent(attributes[key]) + '&'
      }
    }
    url += 'onemind_page_url=' + encodeURIComponent(window.location.href)
    if (document.referrer) url += '&onemind_page_referrer=' + encodeURIComponent(document.referrer)

    var preprocessReady = false;
    var preprocessPayload = null;
    var preprocessTarget = null;

    function sendPreprocessPayload() {
      if (!preprocessReady || preprocessPayload === null) return false;
      if (!preprocessTarget || !preprocessTarget.postMessage) return false;
      preprocessTarget.postMessage({ type: '1MIND_PREPROCESS_COMPLETE', payload: preprocessPayload }, '*');
      preprocessPayload = null;
      return true;
    }

    window.addEventListener('message', function handlePreprocessReady(event) {
      if (!event || !event.data || typeof event.data !== 'object') return;
      if (event.data.type !== '1MIND_PREPROCESS_READY') return;
      preprocessReady = true;
      if (!preprocessTarget && event.source && typeof event.source.postMessage === 'function') preprocessTarget = event.source;
      sendPreprocessPayload();
    });

    function fetchDeferredPreProcessing(iframeHtml, iframe) {
      var sessionDataEl = document.createElement('div');
      sessionDataEl.innerHTML = iframeHtml;
      var sessionEl = sessionDataEl.querySelector('#session-data');
      var sessionId = sessionEl ? sessionEl.dataset.sessionId : null;
      if (!sessionId) return;

      var preprocessUrl = 'https://launcher.prd-b.1mind.com/v1/launch/w9hv2vz6fn/ai-preprocess?';
      if (attributes['onemind_flow']) preprocessUrl += 'flow=' + encodeURIComponent(attributes['onemind_flow']) + '&';
      for (var ppKey in attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, ppKey)) {
          preprocessUrl += encodeURIComponent(ppKey) + '=' + encodeURIComponent(attributes[ppKey]) + '&';
        }
      }
      preprocessUrl += 'onemind_page_url=' + encodeURIComponent(window.location.href);
      if (document.referrer) preprocessUrl += '&onemind_page_referrer=' + encodeURIComponent(document.referrer);
      preprocessUrl += '&sessionId=' + encodeURIComponent(sessionId);

      fetch(preprocessUrl)
        .then(function(resp) { return resp.ok ? resp.json().catch(() => null) : null; })
        .then(function(data) {
          if (!data) return;
          preprocessPayload = data.enriched || {};
          if (!preprocessTarget && iframe && iframe.contentWindow) preprocessTarget = iframe.contentWindow;
          sendPreprocessPayload();
        })
        .catch(function(error) { console.warn('Deferred pre-processing failed:', error); });
    }

    // ---- Floating widget mode (fixed, bottom-right) ----
    let offset = 0;
    let widgetPosition = 'bottom-right';
    let finalWidgetElement;
    let sendScreenSizeStatus;
    let widgetIframe;
    let expectedWidgetOrigin = null;
    let isSmallScreen = window.innerWidth < 500;
    let isTabletScreen = window.innerWidth >= 500 && window.innerWidth < 1024;

    const existingWidgetElement = document.querySelector('#onemind-widget') ?? document.querySelector('#onemind-embed')

    fetch(url)
      .then((response) => response.text())
      .then((iframeHtml) => {
        if (existingWidgetElement) {
          existingWidgetElement.innerHTML = iframeHtml
          const iframe = existingWidgetElement.querySelector("iframe")
          if (iframe) iframe.id = "onemind-iframe"
          finalWidgetElement = existingWidgetElement;
        } else {
          const divElement = document.createElement("div")
          divElement.innerHTML = iframeHtml
          const iframe = divElement.querySelector("iframe")
          if (iframe) iframe.id = "onemind-iframe"
          document.body.append(divElement)
          finalWidgetElement = divElement
        }

        finalWidgetElement.id = "onemind-widget"

        widgetIframe = finalWidgetElement.querySelector("iframe");
        expectedWidgetOrigin = widgetIframe && widgetIframe.src ? new URL(widgetIframe.src).origin : null;

        sendScreenSizeStatus = function () {
          isSmallScreen = window.innerWidth < 500;
          isTabletScreen = window.innerWidth >= 500 && window.innerWidth < 1024;
          if (widgetIframe?.contentWindow) {
            widgetIframe.contentWindow.postMessage({ type: "1MIND_SCREEN_RESIZE", payload: { isSmallScreen, isTabletScreen } }, "*");
          }
        }
        window.addEventListener("resize", sendScreenSizeStatus);

        if (!finalWidgetElement.style.height) finalWidgetElement.style.height = isSmallScreen ? "100px" : "380px";
        if (!finalWidgetElement.style.width) finalWidgetElement.style.width = isSmallScreen ? "100px" : "300px";

        finalWidgetElement.style.position = "fixed";
        finalWidgetElement.style.bottom = "24px";
        finalWidgetElement.style.right = "24px";
        finalWidgetElement.style.zIndex = "2147483647";
        finalWidgetElement.style.pointerEvents = "auto";

        fetchDeferredPreProcessing(iframeHtml, widgetIframe)
      })
      .catch((error) => console.error("Error fetching iframe:", error));

    window.addEventListener("message", (event) => {
      try {
        if (!widgetIframe || !widgetIframe.contentWindow) return;
        if (event.source !== widgetIframe.contentWindow) return;
        if (!expectedWidgetOrigin || event.origin !== expectedWidgetOrigin) return;

        let data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data.payload) data = data.payload;

        if (data && data.state) {
          if (data.state === "1mind_unsupported_browser") { finalWidgetElement.style.display = "none"; return; }
          if (data.state === "1mind_action_scroll_down") {
            const target = new URL(data.url);
            if (target.hash) document.getElementById(target.hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
          } else if (data.state === "1mind_action_open_in_same_tab") {
            var navTarget; try { navTarget = new URL(data.url); } catch (e) { return; }
            if (navTarget.protocol !== "http:" && navTarget.protocol !== "https:") return;
            window.open(navTarget.toString(), "_self");
          } else if (data.state === "1mind_widget_loaded") {
            if (typeof sendScreenSizeStatus === "function") sendScreenSizeStatus();
          } else if (data.state === "1mind_sh_experience_ready") {
            triggerContextUpdate();
          } else if (data.state === "1mind_widget_offset") {
            offset = Number.parseInt(data.offset, 10) || 0;
          } else if (data.state === "1mind_widget_position" || data.state === "widget_position") {
            widgetPosition = data.position || "bottom-right";
          } else if (finalWidgetElement) {
            if (data.state === "1mind_mobile_modal") {
              finalWidgetElement.style.top = "50%";
              if (widgetPosition === "bottom-right") { finalWidgetElement.style.left = "50%"; finalWidgetElement.style.transform = "translate(-50%, -50%)"; }
              else { finalWidgetElement.style.left = "0%"; finalWidgetElement.style.transform = "translate(0%, -50%)"; }
            } else {
              finalWidgetElement.style.top = "";
              finalWidgetElement.style.left = "";
              finalWidgetElement.style.transform = "";
            }
            if (data.state === "1mind_mobile_widget") {
              if (widgetPosition === 'bottom-right') finalWidgetElement.style.right = "12px";
              else { finalWidgetElement.style.left = "12px"; finalWidgetElement.style.right = ""; }
              finalWidgetElement.style.bottom = "12px";
            } else if (!["1mind_tooltip_visible","1mind_tooltip_hidden","1mind_mobile_modal"].includes(data.state)) {
              finalWidgetElement.style.bottom = isSmallScreen ? "12px" : 24 + offset + "px";
              if (widgetPosition === "bottom-right") finalWidgetElement.style.right = isSmallScreen ? "12px" : "24px";
              else if (widgetPosition === "bottom-left") { finalWidgetElement.style.left = isSmallScreen ? "12px" : "24px"; finalWidgetElement.style.right = ""; }
              if (data.state === "1mind_slide_expanded") { finalWidgetElement.style.bottom = "0px"; finalWidgetElement.style.left = "0px"; finalWidgetElement.style.right = "0px"; }
            }
            if (data.height) finalWidgetElement.style.height = data.height;
            if (data.width) finalWidgetElement.style.width = data.width;
          }
        }
      } catch (error) { console.warn("Error parsing message data:", error); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
}

initializeScript()

})()
