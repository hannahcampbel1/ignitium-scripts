
(function () {

  /** ---------- OnemindSDK Start ---------- */

  // this system implements JSON-RPC 2.0. https://www.jsonrpc.org/specification

/* eslint-disable */ // our current eslint is not parsing this js file correctly. All other eslint errors have been removed

/* eslint-disable no-undef */

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
      // ----- event handlers -----
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
      // ----- widget functions -----
      sendSessionContextEvent: async (payload) => this._request(this._iframeFunctionNames.sessionContextEvent, payload),
      setWidgetZIndex: (zIndex) => this._setWidgetZIndex(zIndex),
      startConversation: () => this._request(this._iframeFunctionNames.startConversation),
    }
  }

  // Initializes the SDK and sets up the single message listener.
  init() {
    const frame = document.getElementById(this.iframeId)
    if (!frame || !frame.contentWindow) {
      throw this._createError(`onemind: Iframe #${this.iframeId} not found.`, this._sdkErrorCodes.iframeNotFound, {
        retryable: true,
      })
    }

    this.iframeWindow = frame.contentWindow

    // Try to determine targetOrigin from src if not provided
    if (!this.targetOrigin && frame.src) {
      try {
        this.targetOrigin = new URL(frame.src).origin
      } catch (e) {
        throw this._createError(
          'onemind: Could not determine targetOrigin from iframe src.',
          this._sdkErrorCodes.targetOriginInvalid,
          {
            retryable: true,
          },
        )
      }
    }

    if (!this.targetOrigin) {
      throw this._createError('onemind: targetOrigin is required for security.', this._sdkErrorCodes.targetOriginMissing, {
        retryable: true,
      })
    }

    // One single listener for all communication
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
      try {
        handler(params || {})
      } catch (err) {
        throw new Error(`onemind: Error in event handler for ${method}:`)
      }
    }
  }

  _request(method, params = [], options = {}) {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : this.timeoutMs

    if (options.skipInit !== true) {
      try {
        this.init()
      } catch (error) {
        return Promise.reject(error)
      }
    }

    if (!this.iframeWindow) {
      return Promise.reject(
        this._createError('onemind: SDK not ready', this._sdkErrorCodes.sdkNotReady, {
          method,
          retryable: true,
        }),
      )
    }

    const id = this._generateId()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(
            this._createError(`onemind: Request ${method} timed out`, this._sdkErrorCodes.requestTimeout, {
              method,
              retryable: true,
            }),
          )
        }
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })

      this.iframeWindow.postMessage(
        {
          jsonrpc: '2.0',
          method: method,
          params: params,
          id: id,
        },
        this.targetOrigin,
      )
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
    if (error.code === this._sdkErrorCodes.requestTimeout) {
      return error.method === this._iframeFunctionNames.registerEvent
    }
    return true
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async _register(eventName, handler) {
    if (typeof handler !== 'function') {
      throw new Error('onemind: Handler must be a function')
    }

    let registrationError

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        this.init()

        await this._request(this._iframeFunctionNames.registerEvent, {
          eventName: eventName,
        }, {
          timeoutMs: this.registerTimeoutMs,
          skipInit: true,
        })

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

    throw this._createError('onemind: Failed to register event handler', this._sdkErrorCodes.registerEventFailed, {
      method: this._iframeFunctionNames.registerEvent,
      cause: registrationError,
    })
  }

  _unregister(eventName) {
    return this.eventHandlers.delete(eventName)
  }

  _generateId() {
    return crypto.randomUUID()
  }

  _getWidgetElement() {
    const widget = document.getElementById(this._widgetId) ?? document.getElementById(this._embedId)
    if (widget) return widget
    return undefined
  }

  _setWidgetZIndex(zIndex) {
    const widget = this._getWidgetElement()
    if (!widget) {
      throw new Error('onemind: widget is not loaded yet')
    }
    widget.style.setProperty('z-index', zIndex, 'important')
  }
}

if (typeof window !== "undefined") {
  const onemindSDK = new OnemindSDK();
  window.onemind = onemindSDK;
}

/** ---------- OnemindSDK End ---------- */


/** ---------- Page Context Start ---------- */

const PRUNE_RE =
  /^(script|style|noscript|template|iframe|object|embed|canvas|svg|source|track|picture|video|audio|meta|link|base)$/i;
const DOM_SETTLE_MS = 300;
const OBSERVE_FOR_MS = 1000;
const DEBOUNCE_MS = 150;

function isValidLocale(candidate) {
  try {
    var canonical = Intl.getCanonicalLocales(candidate)[0];
    if (canonical && !/[-_]/.test(candidate) && candidate.length > 2) {
      return null;
    }
    return canonical ? canonical.split('-')[0].toLowerCase() : null;
  } catch (e) {
    return null;
  }
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
      if (sub.toLowerCase() === 'www' && hostParts.length > 3) {
        sub = hostParts[1];
      }
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
    t = setTimeout(function () {
      fn.apply(null, args);
    }, ms);
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
  try {
    return new URL(href, location.href).toString();
  } catch (e) {
    return "";
  }
}

function isHttp(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function stripUTM(url) {
  try {
    const u = new URL(url);
    const drop = {
      utm_source: 1, utm_medium: 1, utm_campaign: 1, utm_term: 1, utm_content: 1,
      gclid: 1, fbclid: 1, igshid: 1, mc_cid: 1, mc_eid: 1, yclid: 1,
    };
    u.searchParams.forEach(function (_v, k) {
      if (drop[k]) u.searchParams.delete(k);
    });
    return u.toString();
  } catch (e) {
    return url;
  }
}

const BLOCKS = {
  p: 1, div: 1, section: 1, article: 1, li: 1, ul: 1, ol: 1, pre: 1,
  blockquote: 1, table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, td: 1, th: 1,
  h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, footer: 1, main: 1, aside: 1, nav: 1,
};
const LINEBREAKS = { br: 1, hr: 1 };

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
        let text = getVisibleText(node);
        text = text.replace(/\s+/g, " ").trim();
        if (!text) text = abs;
        out.push("[" + text + "](" + abs + ")");
      } else {
        const t2 = getVisibleText(node).replace(/\s+/g, " ").trim();
        if (t2) out.push(t2);
      }
      return;
    }
  }

  if (node.nodeType === 3) {
    const val = node.nodeValue || "";
    if (val.trim()) out.push(val);
    return;
  }

  let child = node.firstChild;
  while (child) {
    collectTextWithLinks(child, out);
    child = child.nextSibling;
  }
}

function getVisibleText(el) {
  const buf = [];
  const walker = document.createTreeWalker(
    el,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: function (n) {
        if (n.nodeType === 3) {
          return n.nodeValue && n.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
        if (n.nodeType === 1) {
          const tag = n.tagName.toLowerCase();
          if (PRUNE_RE.test(tag)) return NodeFilter.FILTER_REJECT;
          return isElementVisible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_REJECT;
      },
    }
  );
  let cur;
  while ((cur = walker.nextNode())) {
    if (cur.nodeType === 3) buf.push(cur.nodeValue);
  }
  return buf.join(" ");
}

function extractVisibleTextWithInlineLinks() {
  const root = document.body;
  if (!root) return "";
  const out = [];
  collectTextWithLinks(root, out);
  let text = out.join("");
  text = text
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function debounceNav(callback) {
  let t;
  return function () {
    clearTimeout(t);
    t = setTimeout(callback, DEBOUNCE_MS);
  };
}

function onNavigation(callback) {
  try {
    let oldHref = location.href;
    const fire = debounceNav(callback);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        oldHref = location.href;
        fire();
      }, { once: true });
    } else {
      oldHref = location.href;
      fire();
    }

    window.addEventListener("popstate", function () {
      if (oldHref !== location.href) { oldHref = location.href; fire(); }
    });
    window.addEventListener("hashchange", function () {
      if (oldHref !== location.href) { oldHref = location.href; fire(); }
    });

    ["pushState", "replaceState"].forEach((type) => {
      const orig = history[type];
      if (typeof orig !== "function") return;
      history[type] = function () {
        const ret = orig.apply(this, arguments);
        if (oldHref !== location.href) { oldHref = location.href; fire(); }
        return ret;
      };
    });
  } catch (e) {
    console.error("Error in getting page context:", e);
  }
}

function buildContextPayload() {
  const pageText = true ? extractVisibleTextWithInlineLinks() : "";
  return {
    pageURL: window.location.href,
    pageReferrer: document.referrer || "",
    pageTitle: document.title || "",
    pageTextWithLinks: pageText,
    timestamp: new Date().toISOString(),
  };
}

function postPayloadToIframe(payload) {
  let iframe = document.querySelector("#onemind-iframe");
  if (iframe?.contentWindow) {
    iframe.contentWindow.postMessage({ type: "CONTEXT_UPDATE", payload }, "*");
  }
}

function triggerContextUpdate() {
  try {
    setTimeout(function () {
      const payload = buildContextPayload();
      postPayloadToIframe(payload);

      if (!true) return;

      const endAt = Date.now() + OBSERVE_FOR_MS;
      const recapture = debounce(function () {
        const p2 = buildContextPayload();
        postPayloadToIframe(p2);
      }, DEBOUNCE_MS);

      const mo = new MutationObserver(function () {
        if (Date.now() > endAt) { mo.disconnect(); return; }
        recapture();
      });
      mo.observe(document, { subtree: true, childList: true, characterData: true });

      setTimeout(function () {
        try { mo.disconnect(); } catch (e) {}
      }, OBSERVE_FOR_MS + 50);
    }, DOM_SETTLE_MS);
  } catch (e) {
    console.error("Error in getting page context:", e);
  }
}

onNavigation(triggerContextUpdate);

/** ---------- Page Context END ---------- */

function waitForConsent(callback) {
  const checkInterval = 100
  const maxWaitTime = 0
  let elapsedTime = 0
  const interval = setInterval(() => {
    if (document.cookie.split('; ').some((row) => row.startsWith(''))) {
      clearInterval(interval)
      callback()
    } else {
      elapsedTime += checkInterval
      if (elapsedTime >= maxWaitTime) {
        clearInterval(interval)
        console.warn('Consent cookie not found within the time limit.')
        callback()
      }
    }
  }, checkInterval)
}

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(uuid)
}

function setCookie(name, value, days) {
  let expires = ""
  if (days) {
    const date = new Date()
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000)
    expires = "; expires=" + date.toUTCString()
  }
  const isSecure = window.location.protocol === "https:"
  const secureFlag = isSecure ? "; Secure" : ""
  const sameSiteFlag = "; SameSite=Lax"
  document.cookie = name + "=" + (value || "") + expires + "; path=/" + secureFlag + sameSiteFlag
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
  const scripts = [...document.querySelectorAll('script')]
  const currentScript = scripts.find((script) => {
    const scriptUrl = script.src.replace(/^https?:\/\//, '')
    const reqUrl = 'http://launcher.1mind.com/zgjtpd5cw9?flow=default'.replace(/^https?:\/\//, '')
    return scriptUrl.includes(reqUrl)
  })

  if (currentScript) {
    for (const attr of currentScript.attributes) {
      if (attr.name.startsWith('data-')) {
        queryParams['onemind_' + attr.name.slice(5)] = attr.value
      }
    }
  }

  const params = new URLSearchParams(globalThis.location.search)
  for (const [key, value] of params.entries()) {
    queryParams['onemind_' + key] = value
  }

  try {
    const localStorageKeys = []
    for (const key of localStorageKeys) {
      const value = localStorage.getItem(key)
      if (value !== null) queryParams['onemind_' + key] = decodeURIComponent(value)
    }
  } catch (e) {
    console.warn('Failed to access localStorage:', e)
  }

  try {
    const cookieKeys = []
    for (const key of cookieKeys) {
      const value = getCookie(key)
      if (value !== null) queryParams['onemind_' + key] = decodeURIComponent(value)
    }
  } catch (e) {
    console.warn('Failed to access cookie:', e)
  }

  try {
    const sessionStorageKeys = []
    for (const key of sessionStorageKeys) {
      const value = sessionStorage.getItem(key)
      if (value !== null) queryParams['onemind_' + key] = decodeURIComponent(value)
    }
  } catch (e) {
    console.warn('Failed to access sessionStorage:', e)
  }

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
      if (key.startsWith('onemind_')) {
        attributes[key] = value
      }
    }

    if (true) {
      attributes['onemind_omusertoken'] = getCookie("om_user_token")
      const tokenValue = attributes['onemind_omusertoken']
      const isValidToken = tokenValue && isValidUUID(tokenValue)

      if (!isValidToken) {
        const token = crypto.randomUUID()
        setCookie("om_user_token", token, 365)
        attributes['onemind_omusertoken'] = token
      }
    }

    let url = 'https://launcher.prd-b.1mind.com/v1/launch/zgjtpd5cw9/ai-start?'
    if (attributes['onemind_flow']) {
      url += 'flow=' + encodeURIComponent(attributes['onemind_flow']) + '&'
    }
    for (const key in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        url += encodeURIComponent(key) + '=' + encodeURIComponent(attributes[key]) + '&'
      }
    }

    const pageUrl = window.location.href
    url += 'onemind_page_url=' + encodeURIComponent(pageUrl) + '&'
    const pageReferrer = document.referrer
    if (pageReferrer) {
      url += 'onemind_page_referrer=' + encodeURIComponent(pageReferrer) + '&'
    }

    if (url.endsWith('&')) {
      url = url.slice(0, -1)
    }

    var preprocessReady = false;
    var preprocessPayload = null;
    var preprocessTarget = null;

    function sendPreprocessPayload() {
      if (!preprocessReady || preprocessPayload === null) return false;
      if (!preprocessTarget || !preprocessTarget.postMessage) return false;
      preprocessTarget.postMessage({
        type: '1MIND_PREPROCESS_COMPLETE',
        payload: preprocessPayload
      }, '*');
      preprocessPayload = null;
      return true;
    }

    function handlePreprocessReady(event) {
      if (!event || !event.data || typeof event.data !== 'object') return;
      if (event.data.type !== '1MIND_PREPROCESS_READY') return;

      preprocessReady = true;
      if (!preprocessTarget && event.source && typeof event.source.postMessage === 'function') {
        preprocessTarget = event.source;
      }
      sendPreprocessPayload();
    }

    window.addEventListener('message', handlePreprocessReady);

    function fetchDeferredPreProcessing(iframeHtml, iframe) {
      if (!true) return;
      var sessionDataEl = document.createElement('div');
      sessionDataEl.innerHTML = iframeHtml;
      var sessionEl = sessionDataEl.querySelector('#session-data');
      var sessionId = sessionEl ? sessionEl.dataset.sessionId : null;
      if (!sessionId) return;

      var preprocessUrl = 'https://launcher.prd-b.1mind.com/v1/launch/zgjtpd5cw9/ai-preprocess?';
      if (attributes['onemind_flow']) {
        preprocessUrl += 'flow=' + encodeURIComponent(attributes['onemind_flow']) + '&';
      }
      for (var ppKey in attributes) {
        if (Object.prototype.hasOwnProperty.call(attributes, ppKey)) {
          preprocessUrl += encodeURIComponent(ppKey) + '=' + encodeURIComponent(attributes[ppKey]) + '&';
        }
      }
      preprocessUrl += 'onemind_page_url=' + encodeURIComponent(pageUrl) + '&';
      if (pageReferrer) {
        preprocessUrl += 'onemind_page_referrer=' + encodeURIComponent(pageReferrer) + '&';
      }
      preprocessUrl += 'sessionId=' + encodeURIComponent(sessionId);

      fetch(preprocessUrl)
        .then(function(resp) {
          if (!resp.ok) { console.warn('Deferred pre-processing failed:', resp.status); return null; }
          return resp.json().catch(function(error) {
            console.warn('Deferred pre-processing failed to parse JSON:', error);
            return null;
          });
        })
        .then(function(data) {
          if (!data) return;
          preprocessPayload = data && data.enriched ? data.enriched : {};
          if (!preprocessTarget && iframe && iframe.contentWindow) {
            preprocessTarget = iframe.contentWindow;
          }
          sendPreprocessPayload();
        })
        .catch(function(error) { console.warn('Deferred pre-processing failed:', error); });
    }

    const widgetElement = document.querySelector('#onemind-widget') ?? document.querySelector('#onemind-embed')

    // Non-landing page / embed logic
    fetch(url)
      .then((response) => response.text())
      .then((iframeHtml) => {
        if (widgetElement) {
          widgetElement.innerHTML = iframeHtml
          const iframe = widgetElement.querySelector("iframe")
          if (iframe) iframe.id = "onemind-iframe"
          if (!widgetElement.style.height) widgetElement.style.height = '100%'
          if (!widgetElement.style.width) widgetElement.style.width = '100%'
        } else {
          const divElement = document.createElement('div')
          divElement.innerHTML = iframeHtml
          const iframe = divElement.querySelector("iframe")
          if (iframe) iframe.id = "onemind-iframe"
          divElement.style.height = '100%'
          divElement.style.width = '100%'
          document.body.append(divElement)
        }
        fetchDeferredPreProcessing(iframeHtml, document.querySelector('#onemind-iframe'))

        var embedIframe = document.querySelector('#onemind-iframe');
        var expectedEmbedOrigin = embedIframe && embedIframe.src
          ? new URL(embedIframe.src).origin
          : null;

        window.addEventListener("message", (event) => {
          try {
            if (!embedIframe || !embedIframe.contentWindow) return;
            if (event.source !== embedIframe.contentWindow) return;
            if (!expectedEmbedOrigin || event.origin !== expectedEmbedOrigin) return;

            let data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            if (data.payload) data = data.payload;

            if (data && data.state) {
              if (["1mind_action_scroll_down", "1mind_action_open_in_same_tab", "1mind_sh_experience_ready"].includes(data.state)) {
                if (data.state === "1mind_action_scroll_down") {
                  const target = new URL(data.url);
                  if (target.hash) {
                    const id = target.hash.slice(1);
                    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
                  }
                } else if (data.state === "1mind_action_open_in_same_tab") {
                  var embedNavTarget;
                  try { embedNavTarget = new URL(data.url); } catch (e) { return; }
                  if (embedNavTarget.protocol !== "http:" && embedNavTarget.protocol !== "https:") return;
                  window.open(embedNavTarget.toString(), "_self");
                } else if (data.state === "1mind_sh_experience_ready") {
                  triggerContextUpdate();
                }
              }
            }
          } catch (error) {
            console.warn("Error parsing message data:", error);
          }
        });
      })
      .catch((error) => console.error('Error fetching iframe:', error))
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
}

initializeScript()

})()
