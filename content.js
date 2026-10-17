/**
 * 掠影 · 电商图片提取 —— 内容脚本
 *
 * 职责：
 * 1. 识别淘宝 / 天猫 / 京东 / 拼多多商家版的商品详情页；
 * 2. 在页面右下角注入唯一的悬浮按钮；
 * 3. 扫描页面中的 img、srcset、懒加载属性、背景图、JSON-LD 等图片来源；
 * 4. 补全 URL、去除缩略图后缀、去重、过滤小图，然后把结果交给 Service Worker。
 */
(() => {
  'use strict';

  const ROOT_ID = 'epd-extract-fab-root';
  const MIN_EDGE = 100; // 最小边长（px）
  const MAX_SCAN = 220; // 最多检测的候选项数量，避免超大页面阻塞
  const MAX_IMAGES = 200; // 最终最多返回的图片数量
  const MEASURE_CONCURRENCY = 8;
  const MEASURE_TIMEOUT = 7000;

  // 常见的懒加载 / 高清图属性。不同平台、不同版本的命名并不统一，这里做兼容。
  const IMAGE_ATTRIBUTES = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-original-src',
    'data-ks-lazyload',
    'data-lazyload',
    'data-lazy',
    'data-url',
    'data-image',
    'data-img',
    'data-big',
    'data-large',
    'data-zoom-image',
    'data-hi-res-src',
    'data-src-large',
    'data-actualsrc',
    'data-echo',
    'data-original-image',
    'data-preview',
    'data-thumb',
    'data-bg',
    'data-background',
    'data-background-image'
  ];

  // 页面框架、推荐位与广告位中的图片通常不属于当前商品，扫描时跳过。
  const EXCLUDED_SELECTOR = [
    'header',
    'footer',
    'nav',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[class*="site-header" i]',
    '[class*="site-footer" i]',
    '[class*="global-nav" i]',
    '[class*="recommend" i]',
    '[class*="guess-you" i]',
    '[class*="guess-like" i]',
    '[class*="advert" i]',
    '[class*="sponsor" i]'
  ].join(',');

  // 背景图通常只出现在这些语义元素上，先缩小 getComputedStyle 的调用范围。
  const BACKGROUND_SELECTORS = [
    '[style*="background" i]',
    '[class*="img" i]',
    '[class*="pic" i]',
    '[class*="photo" i]',
    '[class*="gallery" i]',
    '[class*="swiper" i]',
    '[class*="carousel" i]',
    '[class*="slider" i]',
    '[class*="thumb" i]',
    '[class*="preview" i]',
    '[class*="banner" i]',
    '[class*="cover" i]',
    '[class*="media" i]'
  ].join(',');

  const PLATFORM_LABELS = {
    taobao: '淘宝',
    tmall: '天猫',
    jd: '京东',
    pdd: '拼多多商家版'
  };

  let root = null;
  let button = null;
  let buttonText = null;
  let badge = null;
  let currentState = 'idle';
  let resetTimer = 0;
  let lastHref = '';
  let platformInfo = null;
  let scanToken = 0;

  /* ------------------------------------------------------------------ */
  /* 平台识别                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 只有真正的商品详情页才返回平台信息。
   * 匹配规则刻意区分 path / query，避免在搜索页、店铺页误显示按钮。
   */
  function detectPlatform() {
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return null;
    }

    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const params = url.searchParams;
    const hash = url.hash.toLowerCase();
    const hashQuery = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : null;

    // 淘宝：item.taobao.com/item.htm?id=...
    if (
      (host === 'item.taobao.com' || host.endsWith('.taobao.com')) &&
      /\/item\.htm$/.test(path) &&
      params.has('id')
    ) {
      return { id: 'taobao', label: PLATFORM_LABELS.taobao };
    }

    // 天猫：detail.tmall.com/item.htm?id=...、chaoshi.detail.tmall.com/item.htm?id=...
    if ((host === 'tmall.com' || host.endsWith('.tmall.com')) && /\/item\.htm$/.test(path) && params.has('id')) {
      return { id: 'tmall', label: PLATFORM_LABELS.tmall };
    }

    // 京东：item.jd.com/123456.html、item.m.jd.com/product/123456.html
    if (
      (host === 'item.jd.com' || host === 'item.m.jd.com') &&
      /^\/\d+\.html$/.test(path)
    ) {
      return { id: 'jd', label: PLATFORM_LABELS.jd };
    }
    if (host === 'item.m.jd.com' && /^\/product\/\d+\.html$/.test(path)) {
      return { id: 'jd', label: PLATFORM_LABELS.jd };
    }

    // 拼多多：移动端 goods.html?goods_id=...；商家后台可能是 hash 路由。
    if (
      host === 'pinduoduo.com' ||
      host.endsWith('.pinduoduo.com') ||
      host === 'yangkeduo.com' ||
      host.endsWith('.yangkeduo.com')
    ) {
      const goodsId =
        params.get('goods_id') ||
        params.get('goodsId') ||
        hashQuery?.get('goods_id') ||
        hashQuery?.get('goodsId');
      const route = path + hash;
      const looksLikeProduct =
        /(?:^|\/)(?:goods|product)(?:\/|\.|$)/.test(route) ||
        /goods[_-]?detail|product[_-]?detail/.test(route);
      if (goodsId && looksLikeProduct) {
        return { id: 'pdd', label: PLATFORM_LABELS.pdd };
      }
    }

    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 悬浮按钮                                                           */
  /* ------------------------------------------------------------------ */

  function mountButton() {
    if (root?.isConnected) return;

    const host = document.createElement('div');
    host.id = ROOT_ID;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'epd-fab';
    btn.dataset.state = 'idle';
    btn.title = '提取当前页面的商品图片';
    btn.setAttribute('aria-label', '获取图片');

    // 静态 SVG，不包含任何页面数据，使用 innerHTML 是安全的。
    btn.innerHTML = `
      <span class="epd-fab__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.3"></rect>
          <circle cx="8.8" cy="9.8" r="1.55"></circle>
          <path d="M4.6 17.1l4.6-4.6a1.9 1.9 0 0 1 2.7 0l2.1 2.1 1.6-1.6a1.9 1.9 0 0 1 2.7 0l1.1 1.1"></path>
        </svg>
      </span>
      <span class="epd-fab__text">获取图片</span>
      <span class="epd-fab__badge" aria-hidden="true"></span>
    `;

    host.appendChild(btn);
    (document.body || document.documentElement).appendChild(host);

    root = host;
    button = btn;
    buttonText = btn.querySelector('.epd-fab__text');
    badge = btn.querySelector('.epd-fab__badge');
    button.addEventListener('click', handleExtractClick);

    setState('idle', '获取图片');
  }

  function unmountButton() {
    resetTimer = 0;
    scanToken += 1;
    if (root) root.remove();
    root = null;
    button = null;
    buttonText = null;
    badge = null;
    currentState = 'idle';
    platformInfo = null;
  }

  function setState(state, text) {
    currentState = state;
    if (!button) return;
    button.dataset.state = state;
    button.disabled = state === 'busy';
    button.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
    if (buttonText) buttonText.textContent = text;
  }

  function setBadge(count) {
    if (!badge) return;
    if (!count) {
      badge.classList.remove('is-visible');
      badge.textContent = '';
      return;
    }
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.add('is-visible');
  }

  function scheduleReset(delay = 3200) {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      resetTimer = 0;
      if (currentState !== 'busy') setState('idle', '获取图片');
    }, delay);
  }

  function resetButtonUi() {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = 0;
    setState('idle', '获取图片');
    setBadge(0);
  }

  async function handleExtractClick() {
    if (currentState === 'busy') return;

    const token = ++scanToken;
    setState('busy', '正在扫描…');

    try {
      const images = await extractImages((done, total) => {
        if (token === scanToken && currentState === 'busy') {
          setState('busy', `检测 ${done}/${total}`);
        }
      });

      if (token !== scanToken) return;

      if (!images.length) {
        setState('empty', '未找到商品图');
        scheduleReset(3400);
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'OPEN_GALLERY',
        payload: {
          images,
          pageUrl: location.href,
          pageTitle: document.title,
          platform: platformInfo?.id || '',
          platformLabel: platformInfo?.label || ''
        }
      });

      if (token !== scanToken) return;

      if (!response?.ok) {
        throw new Error(response?.error || '图库打开失败');
      }

      setBadge(images.length);
      setState('success', `已提取 ${images.length} 张`);
      scheduleReset(3200);
    } catch (error) {
      if (token !== scanToken) return;
      console.warn('[掠影] 图片提取失败：', error);
      setState('error', '提取失败，请重试');
      scheduleReset(4200);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 页面同步                                                           */
  /* ------------------------------------------------------------------ */

  function syncPageState() {
    const nextPlatform = detectPlatform();
    const href = location.href;
    const platformChanged = (nextPlatform?.id || null) !== (platformInfo?.id || null);

    if (platformChanged || href !== lastHref) {
      scanToken += 1;
      if (root) resetButtonUi();
    }

    platformInfo = nextPlatform;
    lastHref = href;

    if (!nextPlatform) {
      unmountButton();
      return;
    }

    mountButton();
    if (root && !root.isConnected) {
      mountButton();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 图片提取                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 扫描并测量页面图片。返回按页面出现顺序排列的 [{ url, width, height, source }]。
   */
  async function extractImages(onProgress) {
    const candidates = new Map();
    let order = 0;

    function addNormalized(url, source, priority, knownSize) {
      if (!url) return;
      const existing = candidates.get(url);
      if (existing) {
        if (priority > existing.priority) {
          existing.priority = priority;
          existing.source = source;
        }
        if (!existing.width && knownSize) {
          existing.width = knownSize.width;
          existing.height = knownSize.height;
        }
        return;
      }
      candidates.set(url, {
        url,
        source,
        priority,
        width: knownSize?.width || 0,
        height: knownSize?.height || 0,
        order: order++
      });
    }

    function add(raw, source, priority, knownSize) {
      addNormalized(normalizeImageUrl(raw), source, priority, knownSize);
    }

    /* 1. <img>：src、currentSrc、srcset、懒加载属性 */
    const imgNodes = document.querySelectorAll('img');
    const imgLimit = Math.min(imgNodes.length, 1200);
    for (let i = 0; i < imgLimit; i += 1) {
      const img = imgNodes[i];
      if (isExcluded(img)) continue;

      const currentRaw = img.currentSrc || img.src || '';
      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;
      const knownSize =
        naturalWidth > 0 && naturalHeight > 0
          ? { width: naturalWidth, height: naturalHeight }
          : null;

      const push = (raw, source, priority) => {
        const normalized = normalizeImageUrl(raw);
        if (!normalized) return;

        // 只有 URL 没有被“还原原图”改写时才复用当前显示尺寸；
        // 否则 200×200 的缩略图会被误当成原图尺寸。
        let rawHref = '';
        try {
          rawHref = new URL(raw, location.href).href;
        } catch {
          rawHref = '';
        }
        const canReuseSize = Boolean(knownSize && raw === currentRaw && rawHref === normalized);
        addNormalized(normalized, source, priority, canReuseSize ? knownSize : null);
      };

      push(img.currentSrc, '页面图片', 80);
      push(img.getAttribute('src'), '页面图片', 78);
      for (const candidate of parseSrcset(img.getAttribute('srcset'))) {
        push(candidate, '高清图', 72);
      }
      for (const candidate of parseSrcset(img.getAttribute('data-srcset'))) {
        push(candidate, '高清图', 70);
      }
      for (const attr of IMAGE_ATTRIBUTES) {
        push(img.getAttribute(attr), '懒加载', 62);
      }
    }

    /* 2. <source>（picture / video） */
    const sourceNodes = document.querySelectorAll('source[srcset], source[data-srcset], source[src]');
    for (const source of Array.from(sourceNodes).slice(0, 400)) {
      if (isExcluded(source)) continue;
      for (const value of [source.getAttribute('srcset'), source.getAttribute('data-srcset')]) {
        for (const candidate of parseSrcset(value)) add(candidate, '高清图', 68);
      }
      add(source.getAttribute('src'), '页面图片', 64);
    }

    /* 3. 任意元素上的懒加载属性（部分平台会把真实地址放在 div 上） */
    const attrSelector = IMAGE_ATTRIBUTES.map((attr) => `[${attr}]`).join(',');
    const attrNodes = document.querySelectorAll(attrSelector);
    for (const node of Array.from(attrNodes).slice(0, 1600)) {
      if (isExcluded(node)) continue;
      for (const attr of IMAGE_ATTRIBUTES) {
        const value = node.getAttribute(attr);
        if (!value) continue;
        // 有些组件把配置对象放在 data-* 里，只处理看起来像 URL 的值。
        if (!/^(?:https?:)?\/\//i.test(value.trim()) && !value.trim().startsWith('/')) continue;
        add(value, '懒加载', 58);
      }
    }

    /* 4. CSS 背景图 */
    const backgroundNodes = document.querySelectorAll(BACKGROUND_SELECTORS);
    const backgroundLimit = Math.min(backgroundNodes.length, 1800);
    for (let i = 0; i < backgroundLimit; i += 1) {
      const node = backgroundNodes[i];
      if (isExcluded(node)) continue;
      let backgroundImage = '';
      try {
        backgroundImage = getComputedStyle(node).backgroundImage;
      } catch {
        continue;
      }
      if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url(')) {
        continue;
      }
      for (const candidate of parseCssUrls(backgroundImage)) {
        add(candidate, '背景图', 52);
      }
    }

    /* 5. meta / link 中的分享图、预加载图 */
    const metaNodes = document.querySelectorAll(
      'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[itemprop="image"]'
    );
    for (const meta of metaNodes) {
      add(meta.getAttribute('content'), '分享图', 88);
    }

    const linkNodes = document.querySelectorAll('link[rel="preload"][as="image"][href], link[rel="image_src"][href]');
    for (const link of linkNodes) {
      add(link.getAttribute('href'), '预加载图', 66);
    }

    /* 6. 商品结构化数据（JSON-LD） */
    extractJsonLdImages((url) => add(url, '商品数据', 94));

    /* 7. 直接指向图片的链接 & 视频封面 */
    const linkAnchors = document.querySelectorAll('a[href]');
    for (const anchor of Array.from(linkAnchors).slice(0, 900)) {
      if (isExcluded(anchor)) continue;
      const href = anchor.getAttribute('href') || '';
      if (/\.(?:jpe?g|png|webp|gif|bmp)(?:[?#]|$)/i.test(href)) {
        add(href, '图片链接', 46);
      }
    }

    for (const video of Array.from(document.querySelectorAll('video[poster]')).slice(0, 20)) {
      if (isExcluded(video)) continue;
      add(video.getAttribute('poster'), '视频封面', 44);
    }

    if (!candidates.size) return [];

    // 优先测量更可能有效的来源；结果最终仍按页面顺序排列。
    const queue = Array.from(candidates.values())
      .sort((a, b) => b.priority - a.priority || a.order - b.order)
      .slice(0, MAX_SCAN);

    const measured = new Array(queue.length);
    const sizeCache = new Map();
    let cursor = 0;
    let finished = 0;

    async function worker() {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        const candidate = queue[index];
        const size = await measureImage(candidate, sizeCache);

        if (size && size.width >= MIN_EDGE && size.height >= MIN_EDGE) {
          measured[index] = {
            url: candidate.url,
            width: size.width,
            height: size.height,
            source: candidate.source,
            order: candidate.order
          };
        }

        finished += 1;
        onProgress?.(finished, queue.length);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(MEASURE_CONCURRENCY, queue.length) }, () => worker())
    );

    return measured
      .filter(Boolean)
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_IMAGES)
      .map(({ order: _order, ...image }) => image);
  }

  function isExcluded(element) {
    if (!(element instanceof Element)) return true;
    try {
      return Boolean(element.closest(EXCLUDED_SELECTOR));
    } catch {
      return false;
    }
  }

  /**
   * 通过实际加载测量图片尺寸。
   * 对于页面已加载且 URL 未被升级的图片，直接复用 naturalWidth / naturalHeight。
   */
  function measureImage(candidate, cache) {
    if (candidate.width >= MIN_EDGE && candidate.height >= MIN_EDGE) {
      return Promise.resolve({ width: candidate.width, height: candidate.height });
    }

    const cached = cache.get(candidate.url);
    if (cached) return cached;

    const promise = new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      const image = new Image();

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        resolve(result);
      };

      timer = window.setTimeout(() => finish(null), MEASURE_TIMEOUT);
      image.onload = () => {
        finish({
          width: image.naturalWidth || 0,
          height: image.naturalHeight || 0
        });
      };
      image.onerror = () => finish(null);
      image.decoding = 'async';
      image.src = candidate.url;

      if (image.complete) {
        if (image.naturalWidth > 0) {
          finish({ width: image.naturalWidth, height: image.naturalHeight });
        } else {
          finish(null);
        }
      }
    });

    cache.set(candidate.url, promise);
    return promise;
  }

  function parseSrcset(value) {
    if (!value || typeof value !== 'string') return [];
    return value
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function parseCssUrls(value) {
    const result = [];
    const pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let match;
    while ((match = pattern.exec(value)) && result.length < 8) {
      if (match[2]) result.push(match[2]);
    }
    return result;
  }

  /**
   * 将页面里的各种写法统一成绝对 URL，并尽量还原 CDN 原图：
   * - 淘宝 / 天猫：xxx.jpg_430x430q90.jpg -> xxx.jpg
   * - 京东：xxx.jpg!/s100x100_jfs/... -> xxx.jpg
   * - 拼多多：去掉 imageView2 之类的缩放参数与 _400x400 后缀
   */
  function normalizeImageUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;

    let value = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!value) return null;
    if (/^(?:data|blob|javascript|about|mailto|tel):/i.test(value)) return null;
    if (/^(?:#|\{)/.test(value)) return null;

    if (value.startsWith('//')) value = `${location.protocol}${value}`;

    let url;
    try {
      url = new URL(value, location.href);
    } catch {
      return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    url.hash = '';
    const host = url.hostname.toLowerCase();

    // 淘宝 / 天猫图片 CDN 的尺寸后缀
    if (/(?:alicdn|taobaocdn|tbcdn)\.(?:com|cn)$/.test(host)) {
      url.pathname = url.pathname.replace(/(\.(?:jpe?g|png|webp|gif|bmp))_[^/]*$/i, '$1');
    }

    // 京东图片的 !/s100x100_jfs/... 后缀
    if (/(?:360buyimg|jdimg)\.com$/.test(host) && url.pathname.includes('!')) {
      url.pathname = url.pathname.split('!')[0];
    }

    // 拼多多图片的缩放参数/尺寸后缀
    if (/(?:pddpic|yangkeduo|pinduoduo)\.com$/.test(host)) {
      url.pathname = url.pathname.replace(/_\d+x\d+(?=\.(?:jpe?g|png|webp|gif|bmp)$)/i, '');

      const cleaned = new URLSearchParams();
      for (const [key, value] of url.searchParams) {
        // 形如 imageView2/2/w/400 的缩放指令没有键值语义，直接丢弃。
        if (/^(?:imageView2|imageMogr2|thumbnail|resize)\//i.test(key)) continue;
        cleaned.append(key, value);
      }
      url.search = cleaned.toString();
    }

    if (/\.(?:svg|ico|css|js)$/i.test(url.pathname)) return null;

    // 过滤常见的 logo、图标、占位图命名
    const pathAndSearch = `${url.pathname}${url.search}`;
    if (
      /(?:^|[/_.-])(?:logo|icon|sprite|avatar|placeholder|spacer|pixel|transparent|blank|nopic|noimage|default-img)(?:[/_.-]|$)/i.test(
        pathAndSearch
      )
    ) {
      return null;
    }

    // 1x1 像素图 / 追踪图
    if (/(?:^|[/_.-])1x1(?:[/_.-]|$)/i.test(pathAndSearch)) return null;
    if (/[?&](?:w|width|h|height)=([1-9]\d?)(?:&|$)/i.test(url.search)) return null;

    // query 顺序归一化，避免同一张图因参数顺序不同而重复
    url.searchParams.sort();

    if (url.href.length > 4096) return null;
    return url.href;
  }

  function extractJsonLdImages(add) {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of Array.from(scripts).slice(0, 12)) {
      let data;
      try {
        data = JSON.parse(script.textContent || '');
      } catch {
        continue;
      }
      walkJsonLd(data, 0, add);
    }
  }

  function walkJsonLd(node, depth, add) {
    if (!node || depth > 9) return;

    if (Array.isArray(node)) {
      for (const item of node) walkJsonLd(item, depth + 1, add);
      return;
    }

    if (typeof node !== 'object') return;

    const typeValue = node['@type'];
    const types = Array.isArray(typeValue) ? typeValue.map(String) : typeValue ? [String(typeValue)] : [];
    if (types.includes('Product') || types.includes('ImageObject')) {
      const values = node.image ?? node.contentUrl ?? node.thumbnailUrl;
      for (const imageUrl of flattenImageValues(values)) {
        add(imageUrl);
      }
    }

    for (const key of ['@graph', 'hasVariant', 'isVariantOf', 'offers', 'itemListElement', 'associatedMedia']) {
      walkJsonLd(node[key], depth + 1, add);
    }
  }

  function flattenImageValues(value, output = []) {
    if (!value) return output;
    if (typeof value === 'string') {
      output.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) flattenImageValues(item, output);
    } else if (typeof value === 'object') {
      for (const key of ['url', 'contentUrl', 'thumbnailUrl']) {
        if (typeof value[key] === 'string') output.push(value[key]);
      }
    }
    return output;
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  syncPageState();

  // SPA 页面不会刷新文档，用低频轮询同步 URL 与按钮状态。
  window.setInterval(() => {
    syncPageState();
    if (platformInfo && (!root || !root.isConnected)) {
      mountButton();
    }
  }, 1200);

  window.addEventListener('popstate', syncPageState);
  window.addEventListener('hashchange', syncPageState);
})();
