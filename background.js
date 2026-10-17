/**
 * 掠影 · Service Worker
 *
 * 职责：
 * 1. 接收内容脚本提取到的图片列表，写入 chrome.storage.session 并打开图库页；
 * 2. 接收图库页的下载请求，调用 chrome.downloads.download 保存 PNG；
 * 3. 把下载状态广播回图库页，便于展示进度与失败原因；
 * 4. 点击扩展图标时打开最近一次提取结果。
 */

const JOB_PREFIX = 'epd:job:';
const LAST_JOB_KEY = 'epd:lastJob';
const JOB_TTL = 24 * 60 * 60 * 1000; // 提取结果保留 24 小时
const MAX_JOBS = 8;
const MAX_IMAGES = 300;
const MAX_URL_LENGTH = 4096;

/* -------------------------------------------------------------------------- */
/* 消息处理                                                                    */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  if (message.type === 'OPEN_GALLERY') {
    handleOpenGallery(message.payload, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'DOWNLOAD_PNG') {
    handleDownload(message.payload, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  return undefined;
});

/* -------------------------------------------------------------------------- */
/* 打开图库                                                                    */
/* -------------------------------------------------------------------------- */

async function handleOpenGallery(payload, sender) {
  if (sender?.id !== chrome.runtime.id) {
    throw new Error('来源未授权');
  }

  const rawImages = Array.isArray(payload?.images) ? payload.images : [];
  const images = rawImages
    .filter((image) => image && typeof image.url === 'string' && /^https?:\/\//i.test(image.url))
    .slice(0, MAX_IMAGES)
    .map((image) => ({
      url: image.url.slice(0, MAX_URL_LENGTH),
      width: toPositiveInteger(image.width),
      height: toPositiveInteger(image.height),
      source: String(image.source || '页面图片').slice(0, 24)
    }));

  if (!images.length) {
    throw new Error('没有可展示的图片');
  }

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    images,
    pageUrl: sanitizeText(payload?.pageUrl, 2048),
    pageTitle: sanitizeText(payload?.pageTitle, 180),
    platform: sanitizeText(payload?.platform, 24),
    platformLabel: sanitizeText(payload?.platformLabel, 24),
    createdAt: Date.now()
  };

  await pruneJobs();

  await chrome.storage.session.set({
    [`${JOB_PREFIX}${jobId}`]: job,
    [LAST_JOB_KEY]: jobId
  });

  const galleryUrl = `${chrome.runtime.getURL('gallery.html')}?job=${encodeURIComponent(jobId)}`;
  const tab = await chrome.tabs.create({ url: galleryUrl });

  return { ok: true, jobId, tabId: tab.id, count: images.length };
}

/* -------------------------------------------------------------------------- */
/* 下载                                                                        */
/* -------------------------------------------------------------------------- */

async function handleDownload(payload, sender) {
  assertTrustedGallerySender(sender);

  const url = typeof payload?.url === 'string' ? payload.url : '';
  const filename = typeof payload?.filename === 'string' ? payload.filename : '';

  // 只允许下载图库页刚刚生成的 Blob URL 或 PNG Data URL。
  if (!/^(?:blob:|data:image\/png)/i.test(url)) {
    throw new Error('下载地址无效');
  }

  if (!/^商品图_\d{3,4}\.png$/.test(filename)) {
    throw new Error('文件名无效');
  }

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  return { ok: true, id: downloadId };
}

/**
 * 下载状态广播。图库页以此判断每张图片何时真正完成，从而安全释放 Blob URL。
 */
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.state) return;

  chrome.runtime
    .sendMessage({
      type: 'DOWNLOAD_STATE',
      id: delta.id,
      state: delta.state.current,
      error: delta.error?.current || ''
    })
    .catch(() => {
      // 图库页已关闭时没有接收方，忽略即可。
    });
});

/* -------------------------------------------------------------------------- */
/* 工具栏图标                                                                  */
/* -------------------------------------------------------------------------- */

chrome.action.onClicked.addListener(async () => {
  let galleryUrl = chrome.runtime.getURL('gallery.html');

  try {
    const stored = await chrome.storage.session.get(LAST_JOB_KEY);
    const jobId = stored?.[LAST_JOB_KEY];
    if (jobId) {
      const jobStored = await chrome.storage.session.get(`${JOB_PREFIX}${jobId}`);
      if (jobStored?.[`${JOB_PREFIX}${jobId}`]) {
        galleryUrl += `?job=${encodeURIComponent(jobId)}`;
      }
    }
  } catch {
    // storage.session 不可用时仍然打开空图库，不影响基本使用。
  }

  await chrome.tabs.create({ url: galleryUrl });
});

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

async function pruneJobs() {
  const all = await chrome.storage.session.get(null);
  const entries = Object.entries(all).filter(([key]) => key.startsWith(JOB_PREFIX));
  const now = Date.now();
  const removeKeys = [];
  const alive = [];

  for (const [key, job] of entries) {
    if (!job || typeof job !== 'object' || now - (job.createdAt || 0) > JOB_TTL) {
      removeKeys.push(key);
    } else {
      alive.push([key, job]);
    }
  }

  alive.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  for (const [key] of alive.slice(MAX_JOBS)) {
    removeKeys.push(key);
  }

  if (removeKeys.length) {
    await chrome.storage.session.remove(removeKeys);
  }
}

function assertTrustedGallerySender(sender) {
  const galleryPrefix = chrome.runtime.getURL('gallery.html');
  if (sender?.id !== chrome.runtime.id || !sender?.url?.startsWith(galleryPrefix)) {
    throw new Error('下载请求来源无效');
  }
}

function toPositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.round(number), 20000);
}

function sanitizeText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function readableError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/quota/i.test(message)) return '提取结果过多，请重试';
  if (/Invalid URL/i.test(message)) return '图片地址无效';
  return message.slice(0, 160);
}
