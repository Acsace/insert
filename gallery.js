/**
 * 掠影 · 图库页
 *
 * 流程：
 * 1. 从 chrome.storage.session 读取内容脚本提交的图片列表；
 * 2. 渲染联系印样网格，支持全选 / 反选 / 单张勾选；
 * 3. 逐张 fetch 原图 → createImageBitmap → canvas → PNG Blob；
 * 4. 交给 Service Worker 调用 chrome.downloads.download 保存；
 * 5. 显示逐张进度、失败原因与最终结果。
 */

const JOB_PREFIX = 'epd:job:';
const MAX_CANVAS_EDGE = 12000;
const MAX_CANVAS_PIXELS = 64_000_000;
const FETCH_TIMEOUT = 45_000;
const DOWNLOAD_TIMEOUT = 120_000;

const elements = {
  platformChip: document.getElementById('platform-chip'),
  sourceHost: document.getElementById('source-host'),
  extractedAt: document.getElementById('extracted-at'),
  sourceLink: document.getElementById('source-link'),
  selectedCount: document.getElementById('selected-count'),
  totalCount: document.getElementById('total-count'),
  selectAll: document.getElementById('select-all'),
  invert: document.getElementById('invert'),
  download: document.getElementById('download'),
  downloadLabel: document.getElementById('download-label'),
  downloadMeta: document.getElementById('download-meta'),
  panel: document.getElementById('download-panel'),
  panelStatus: document.getElementById('download-status'),
  panelCount: document.getElementById('download-progress-text'),
  progressTrack: document.querySelector('.progress-track'),
  progressFill: document.getElementById('progress-fill'),
  failures: document.getElementById('failures'),
  failuresSummary: document.getElementById('failures-summary'),
  failuresList: document.getElementById('failures-list'),
  grid: document.getElementById('grid'),
  loading: document.getElementById('loading'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyCopy: document.getElementById('empty-copy'),
  toast: document.getElementById('toast'),
  cardTemplate: document.getElementById('card-template')
};

const state = {
  images: [],
  cards: [],
  selected: new Set(),
  downloading: false,
  failures: [],
  toastTimer: 0,
  downloadWaiters: new Map()
};

/* -------------------------------------------------------------------------- */
/* 初始化                                                                      */
/* -------------------------------------------------------------------------- */

init();

async function init() {
  bindEvents();

  const jobId = new URLSearchParams(location.search).get('job');
  if (!jobId) {
    showEmpty('还没有可展示的图片', '打开淘宝、天猫、京东或拼多多商家版的商品详情页，点击右下角「获取图片」。');
    return;
  }

  try {
    const key = `${JOB_PREFIX}${jobId}`;
    const stored = await chrome.storage.session.get(key);
    const job = stored?.[key];

    if (!job) {
      showEmpty(
        '这次提取结果已过期',
        '浏览器重启或结果超过 24 小时后会自动清理。请回到商品详情页，重新点击「获取图片」。'
      );
      return;
    }

    const images = normalizeImages(job.images);
    if (!images.length) {
      showEmpty('没有找到可用的图片', '页面中的图片可能尚未加载完成，请回到商品页稍等片刻后重新提取。');
      return;
    }

    state.images = images;
    state.selected = new Set(images.map((_, index) => index));

    renderHeader(job);
    renderGrid();
    updateSelection();
    showGallery();
  } catch (error) {
    console.error('[掠影] 读取提取结果失败：', error);
    showEmpty('读取提取结果失败', '扩展的临时存储不可用或已被清理，请回到商品页重新提取。');
  }
}

/* -------------------------------------------------------------------------- */
/* 事件绑定                                                                    */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  elements.selectAll.addEventListener('click', () => {
    if (state.downloading || !state.images.length) return;
    toggleSelectAll();
  });

  elements.invert.addEventListener('click', () => {
    if (state.downloading || !state.images.length) return;
    invertSelection();
  });

  elements.download.addEventListener('click', () => {
    startDownload();
  });

  elements.grid.addEventListener('change', (event) => {
    const input = event.target.closest('.shot__checkbox');
    if (!input) return;
    const index = Number(input.dataset.index);
    if (!Number.isInteger(index)) return;

    if (input.checked) state.selected.add(index);
    else state.selected.delete(index);

    input.closest('.shot')?.classList.toggle('is-selected', input.checked);
    updateSelection();
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta?.state) {
      settleDownloadWaiter(delta.id, delta.state.current, delta.error?.current || '');
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'DOWNLOAD_STATE' && message.state) {
      settleDownloadWaiter(message.id, message.state, message.error || '');
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

function renderHeader(job) {
  const host = safeHostname(job.pageUrl);
  elements.sourceHost.textContent = host || '来源页面';

  if (job.platformLabel) {
    elements.platformChip.textContent = job.platformLabel;
    elements.platformChip.hidden = false;
  }

  const createdAt = new Date(job.createdAt);
  if (Number.isFinite(createdAt.getTime())) {
    elements.extractedAt.textContent = `提取于 ${createdAt.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit'
    })}`;
    elements.extractedAt.hidden = false;
  }

  if (typeof job.pageUrl === 'string' && /^https?:\/\//i.test(job.pageUrl)) {
    elements.sourceLink.href = job.pageUrl;
    elements.sourceLink.hidden = false;
  }

  const title = job.pageTitle ? ` · ${job.pageTitle}` : '';
  document.title = `${state.images.length} 张商品图${title}`;
}

function renderGrid() {
  const fragment = document.createDocumentFragment();
  state.cards = [];

  state.images.forEach((image, index) => {
    const node = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    const checkbox = node.querySelector('.shot__checkbox');
    const img = node.querySelector('.shot__image');
    const indexLabel = node.querySelector('.shot__index');
    const sizeLabel = node.querySelector('.shot__size');
    const sourceLabel = node.querySelector('.shot__source');
    const errorLabel = node.querySelector('.shot__error');
    const stamp = node.querySelector('.shot__stamp');

    const sequence = String(index + 1).padStart(3, '0');
    const sizeText = image.width && image.height ? `${image.width} × ${image.height} px` : '尺寸待确认';

    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkbox.setAttribute('aria-label', `选择第 ${index + 1} 张图片，${sizeText}`);
    node.classList.add('is-selected');

    indexLabel.textContent = sequence;
    sizeLabel.textContent = sizeText;
    sourceLabel.textContent = image.source || '页面图片';
    stamp.textContent = '未完成';
    node.title = image.url;

    img.referrerPolicy = 'no-referrer';
    img.src = image.url;
    img.addEventListener('load', () => {
      if (!image.width || !image.height) {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if (width && height) {
          image.width = width;
          image.height = height;
          sizeLabel.textContent = `${width} × ${height} px`;
          checkbox.setAttribute('aria-label', `选择第 ${index + 1} 张图片，${width} × ${height} px`);
        }
      }
    });
    img.addEventListener('error', () => {
      img.classList.add('is-broken');
      errorLabel.hidden = false;
    });

    state.cards.push({ node, checkbox, img, sizeLabel, stamp });
    fragment.appendChild(node);
  });

  elements.grid.replaceChildren(fragment);
  elements.grid.setAttribute('aria-busy', 'false');
}

function showGallery() {
  elements.loading.hidden = true;
  elements.grid.setAttribute('aria-busy', 'false');
  elements.emptyState.hidden = true;
  elements.totalCount.textContent = String(state.images.length);
  elements.grid.hidden = false;
}

function showEmpty(title, copy) {
  elements.loading.hidden = true;
  elements.grid.setAttribute('aria-busy', 'false');
  elements.grid.hidden = true;
  elements.emptyState.hidden = false;
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = copy;
  elements.selectAll.disabled = true;
  elements.invert.disabled = true;
  elements.download.disabled = true;
}

/* -------------------------------------------------------------------------- */
/* 选择                                                                        */
/* -------------------------------------------------------------------------- */

function toggleSelectAll() {
  const allSelected = state.selected.size === state.images.length;
  state.selected.clear();
  if (!allSelected) {
    state.images.forEach((_, index) => state.selected.add(index));
  }
  syncCheckboxes();
  updateSelection();
}

function invertSelection() {
  const next = new Set();
  state.images.forEach((_, index) => {
    if (!state.selected.has(index)) next.add(index);
  });
  state.selected = next;
  syncCheckboxes();
  updateSelection();
}

function syncCheckboxes() {
  state.cards.forEach((card, index) => {
    const checked = state.selected.has(index);
    card.checkbox.checked = checked;
    card.node.classList.toggle('is-selected', checked);
  });
}

function updateSelection() {
  const total = state.images.length;
  const selected = state.selected.size;
  const allSelected = total > 0 && selected === total;

  elements.selectedCount.textContent = String(selected);
  elements.totalCount.textContent = String(total);
  elements.selectAll.textContent = allSelected ? '取消全选' : '全选';
  elements.selectAll.setAttribute('aria-pressed', allSelected ? 'true' : 'false');
  elements.selectAll.disabled = state.downloading || total === 0;
  elements.invert.disabled = state.downloading || total === 0;
  elements.download.disabled = state.downloading || selected === 0;

  if (!state.downloading) {
    elements.downloadLabel.textContent = '下载选中';
    elements.downloadMeta.textContent = `${selected} 张`;
  }
}

/* -------------------------------------------------------------------------- */
/* 下载                                                                        */
/* -------------------------------------------------------------------------- */

async function startDownload() {
  if (state.downloading) return;

  const chosen = Array.from(state.selected)
    .sort((a, b) => a - b)
    .map((index) => ({ image: state.images[index], index }));

  if (!chosen.length) return;

  state.downloading = true;
  state.failures = [];
  setLocked(true);
  resetPanel(chosen.length);
  updateSelection();
  elements.downloadLabel.textContent = '正在下载';
  elements.downloadMeta.textContent = `0 / ${chosen.length}`;

  let success = 0;

  for (let position = 0; position < chosen.length; position += 1) {
    const { image, index } = chosen[position];
    const filename = `商品图_${String(position + 1).padStart(3, '0')}.png`;

    setPanelStatus(`正在转换 ${position + 1} / ${chosen.length} 张为 PNG`, position, chosen.length);

    try {
      const pngBlob = await convertToPng(image.url);
      await downloadPng(pngBlob, filename);
      success += 1;
    } catch (error) {
      const message = readableError(error);
      state.failures.push({ filename, message, url: image.url });
      markFailed(index);
    }

    updateProgress(position + 1, chosen.length);
    await nextFrame();
  }

  finishDownload(success, chosen.length);
}

function setLocked(locked) {
  elements.grid.classList.toggle('is-locked', locked);
  state.cards.forEach((card) => {
    card.checkbox.disabled = locked;
  });
  elements.selectAll.disabled = locked;
  elements.invert.disabled = locked;
  if (locked) elements.download.disabled = true;
}

function resetPanel(total) {
  elements.panel.hidden = false;
  elements.panel.classList.remove('is-done', 'is-error');
  elements.panelStatus.textContent = '正在准备下载…';
  elements.panelCount.textContent = `0 / ${total}`;
  elements.progressFill.style.width = '0%';
  elements.progressTrack.setAttribute('aria-valuenow', '0');
  elements.failures.hidden = true;
  elements.failuresList.replaceChildren();
  elements.downloadMeta.textContent = `0 / ${total}`;
}

function setPanelStatus(text, done, total) {
  elements.panelStatus.textContent = text;
  elements.panelCount.textContent = `${done} / ${total}`;
}

function updateProgress(done, total) {
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  elements.progressFill.style.width = `${percent}%`;
  elements.progressTrack.setAttribute('aria-valuenow', String(percent));
  elements.panelCount.textContent = `${done} / ${total}`;
  elements.downloadMeta.textContent = `${done} / ${total}`;
}

function finishDownload(success, total) {
  state.downloading = false;
  setLocked(false);
  updateSelection();

  const failed = state.failures.length;
  elements.downloadLabel.textContent = '下载选中';
  elements.downloadMeta.textContent = `${state.selected.size} 张`;
  elements.panel.classList.add(failed ? 'is-error' : 'is-done');
  elements.panelStatus.textContent = failed
    ? `完成 ${success} 张，${failed} 张未完成`
    : `已下载 ${success} 张 PNG`;
  elements.panelCount.textContent = `${total} / ${total}`;
  elements.progressFill.style.width = '100%';
  elements.progressTrack.setAttribute('aria-valuenow', '100');

  if (failed) {
    elements.failures.hidden = false;
    elements.failuresSummary.textContent = `${failed} 张未完成，查看原因`;
    elements.failuresList.replaceChildren(
      ...state.failures.map((failure) => {
        const item = document.createElement('li');
        const name = document.createElement('code');
        name.textContent = failure.filename;
        item.append(name, `：${failure.message}`);
        return item;
      })
    );
  }

  if (success > 0 && failed > 0) {
    showToast(`已保存 ${success} 张 PNG，${failed} 张未完成`);
  } else if (success > 0) {
    showToast(`已保存 ${success} 张 PNG`);
  } else {
    showToast('没有图片下载成功，请查看失败原因');
  }
}

function markFailed(index) {
  const card = state.cards[index];
  if (!card) return;
  card.node.classList.add('is-failed');
  card.node.classList.remove('is-selected');
  card.checkbox.checked = false;
  state.selected.delete(index);
}

/* -------------------------------------------------------------------------- */
/* 图片格式转换                                                                */
/* -------------------------------------------------------------------------- */

async function convertToPng(url) {
  const sourceBlob = await fetchImageBlob(url);
  const canvas = await blobToCanvas(sourceBlob);
  const pngBlob = await canvasToPngBlob(canvas);

  if (!pngBlob || pngBlob.size === 0) {
    throw new Error('PNG 编码失败');
  }
  return pngBlob;
}

async function fetchImageBlob(url) {
  const candidates = [url];
  if (/^http:\/\//i.test(url)) candidates.push(`https://${url.slice(7)}`);

  let lastError = null;

  for (const candidate of candidates) {
    // 先带 Cookie（部分商品图依赖登录态），失败后再尝试匿名请求。
    for (const credentials of ['include', 'omit']) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      try {
        const response = await fetch(candidate, {
          credentials,
          cache: 'default',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        if (!blob.size) throw new Error('图片内容为空');
        return blob;
      } catch (error) {
        lastError = error;
      } finally {
        window.clearTimeout(timer);
      }
    }
  }

  throw lastError || new Error('图片下载失败');
}

async function blobToCanvas(blob) {
  let bitmap = null;

  try {
    bitmap = await createImageBitmap(blob);
    return drawToCanvas(bitmap);
  } catch {
    // createImageBitmap 解码失败时，退回 <img> 解码。
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadHtmlImage(objectUrl);
    return drawToCanvas(image);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawToCanvas(source) {
  const sourceWidth = source.width || source.naturalWidth || 0;
  const sourceHeight = source.height || source.naturalHeight || 0;

  if (!sourceWidth || !sourceHeight) {
    throw new Error('无法读取图片尺寸');
  }

  let scale = 1;
  const longestEdge = Math.max(sourceWidth, sourceHeight);
  if (longestEdge > MAX_CANVAS_EDGE) {
    scale = MAX_CANVAS_EDGE / longestEdge;
  }

  const pixels = sourceWidth * sourceHeight * scale * scale;
  if (pixels > MAX_CANVAS_PIXELS) {
    scale = Math.sqrt(MAX_CANVAS_PIXELS / (sourceWidth * sourceHeight));
  }

  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建画布');

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

function loadHtmlImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = src;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败'));
    }, 'image/png');
  });
}

/* -------------------------------------------------------------------------- */
/* 下载调度                                                                    */
/* -------------------------------------------------------------------------- */

async function downloadPng(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);

  try {
    const downloadId = await requestDownload(objectUrl, filename);
    await waitForDownload(downloadId);
  } finally {
    // 下载完成后留一点缓冲时间，避免浏览器尚未读取完 Blob。
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }
}

async function requestDownload(url, filename) {
  let backgroundError = null;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PNG',
      payload: { url, filename }
    });

    if (response?.ok && Number.isInteger(response.id)) {
      return response.id;
    }
    backgroundError = new Error(response?.error || '后台下载失败');
  } catch (error) {
    backgroundError = error;
  }

  // 极少数浏览器/策略环境会拒绝 Service Worker 下载 Blob URL，此时在页面内直接下载。
  console.warn('[掠影] 后台下载未成功，尝试页面内下载：', backgroundError);

  try {
    return await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });
  } catch (error) {
    throw new Error(`无法开始下载：${readableError(error)}`);
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      state.downloadWaiters.delete(downloadId);
      if (error) reject(error);
      else resolve();
    };

    state.downloadWaiters.set(downloadId, { finish });

    timer = window.setTimeout(() => finish(new Error('下载超时')), DOWNLOAD_TIMEOUT);

    chrome.downloads
      .search({ id: downloadId })
      .then((items) => {
        const item = items?.[0];
        if (!item || settled) return;
        if (item.state === 'complete') finish();
        else if (item.state === 'interrupted') finish(new Error(item.error || '下载被中断'));
      })
      .catch(() => {
        // 事件监听仍会负责后续状态。
      });
  });
}

function settleDownloadWaiter(downloadId, status, error) {
  const waiter = state.downloadWaiters.get(downloadId);
  if (!waiter) return;

  if (status === 'complete') {
    waiter.finish();
  } else if (status === 'interrupted') {
    waiter.finish(new Error(error || '下载被中断'));
  }
}

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function normalizeImages(rawImages) {
  if (!Array.isArray(rawImages)) return [];
  const seen = new Set();
  const result = [];

  for (const image of rawImages) {
    if (!image || typeof image.url !== 'string' || !/^https?:\/\//i.test(image.url)) continue;
    if (seen.has(image.url)) continue;
    seen.add(image.url);

    result.push({
      url: image.url,
      width: positiveInteger(image.width),
      height: positiveInteger(image.height),
      source: String(image.source || '页面图片')
    });

    if (result.length >= 300) break;
  }

  return result;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), 20000) : 0;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function readableError(error) {
  const raw = String(error?.message || error || '未知错误');

  if (/AbortError|aborted/i.test(raw)) return '图片请求超时';
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '图片服务器拒绝访问或已失效';
  if (/HTTP (\d+)/i.test(raw)) return `图片服务器返回 HTTP ${raw.match(/HTTP (\d+)/i)[1]}`;
  if (/decode|解码/i.test(raw)) return '图片格式无法解码';
  if (/interrupted|USER_CANCELED|DOWNLOAD_CANCELED/i.test(raw)) return '下载被中断';
  if (/Invalid URL/i.test(raw)) return '图片地址无效';

  return raw.slice(0, 120);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');

  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('is-visible');
    state.toastTimer = 0;
  }, 3600);
}
