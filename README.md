# 掠影 · 电商图片提取

一个基于 Manifest V3 的浏览器扩展（Edge / Chrome 通用）。在淘宝、天猫、京东、拼多多商家版的商品详情页点击右下角「获取图片」，即可在新标签页中集中查看、勾选并批量下载商品图片为 PNG。

## 安装

1. 下载或复制本项目文件夹到本地。
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）。
3. 打开右上角「开发人员模式」。
4. 点击「加载解压缩的扩展」，选择本项目根目录（包含 `manifest.json` 的文件夹）。
5. 建议把「掠影」固定到浏览器工具栏，方便再次打开最近一次提取结果。

## 使用

1. 打开受支持的商品详情页：
   - 淘宝：`item.taobao.com/item.htm?id=...`
   - 天猫：`detail.tmall.com/item.htm?id=...`
   - 京东：`item.jd.com/<商品ID>.html`
   - 拼多多商家版 / 移动端：带 `goods_id` 的商品详情页
2. 页面右下角出现「获取图片」按钮，点击后等待扫描完成。
3. 扩展会自动打开图库页，默认全选提取到的图片。
4. 点击图片或复选框调整选择，也可以使用「全选 / 反选」。
5. 点击「下载选中」，扩展会逐张转换为 PNG 并保存到浏览器默认下载目录，文件名为 `商品图_001.png`、`商品图_002.png`……。
6. 下载过程中请保持图库页打开；页面顶部会显示进度，完成后给出成功 / 失败数量。失败项可以展开查看原因。

## 实现说明

- **页面识别**：内容脚本在所有目标域名下运行，但只有 URL 命中商品详情规则时才注入按钮；同时轮询 URL，兼容 SPA 页面切换。
- **图片来源**：`img` 的 `src` / `currentSrc` / `srcset`、常见懒加载属性（`data-src`、`data-lazy-src`、`data-original`、`data-ks-lazyload` 等）、`<source>`、CSS `background-image`、`og:image`、JSON-LD 商品数据、视频封面和指向图片的链接。
- **原图还原**：识别并去掉淘宝 / 天猫 CDN 的 `_430x430q90.jpg` 尺寸后缀、京东的 `!/s100x100_jfs/...` 后缀、拼多多的 `imageView2` 缩放参数与 `_400x400` 后缀。
- **过滤**：补全相对路径、去重；过滤 SVG/ICO、logo/icon/占位图、1×1 像素图，以及任一边小于 100px 的图片。
- **PNG 转换**：图库页在扩展源下 `fetch` 原图（依赖 `host_permissions` 绕过跨域限制），通过 `createImageBitmap` + `canvas.toBlob('image/png')` 重新编码；再由 Service Worker 调用 `chrome.downloads.download` 完成保存。
- **临时数据**：提取结果写入 `chrome.storage.session`，保留 24 小时、最多 8 份，浏览器关闭后自动清空。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `downloads` | 批量保存转换后的 PNG |
| `storage` | 在内容脚本、Service Worker 与图库页之间传递提取结果 |
| `activeTab` / `scripting` | 预留的当前标签页能力（扩展使用静态内容脚本注入） |
| 平台与图片 CDN 域名 | 在扩展页中读取跨域商品图并转换为 PNG |

`host_permissions` 除三个平台域名外，还包含实际承载图片的 CDN：`alicdn.com`、`taobaocdn.com`、`tbcdn.cn`、`360buyimg.com`、`jdimg.com`、`pddpic.com`。若商品图来自其他第三方域名，图库仍会展示缩略图，但跨域转换可能失败，并在下载结果中给出原因。

## 文件结构

```
manifest.json      扩展清单（MV3）
content.js         商品页识别、悬浮按钮、图片提取与过滤
content.css        悬浮按钮样式（#epd-extract-fab-root 作用域）
background.js      Service Worker：任务存储、打开图库、下载调度
gallery.html       图库页面结构
gallery.css        图库样式
gallery.js         勾选、PNG 转换、进度与结果反馈
icons/             扩展图标（16 / 32 / 48 / 128）
```

## 局限与注意

- 只提取当前商品页中已渲染或能通过懒加载属性发现的图片，不会自动翻页、切换 SKU 或抓取详情描述中尚未加载的资源。切换 SKU 后请重新提取。
- 单次最多返回 200 张、单张边长超过 12000px 或总像素超过 6400 万的图片会被按比例缩小后再编码，以避免浏览器画布内存溢出。
- 商品图受平台版权保护，请仅用于自己有权使用的场景，并遵守各平台规则。
