/**
 * 图提取 · 宣传页交互
 * 纯原生 JS，无依赖，可直接通过 file:// 打开。
 *
 * 包含：
 * 1. 导航吸顶阴影 / 当前区块高亮
 * 2. 移动端汉堡菜单（点击外部、Esc、点击链接、放大窗口时自动关闭）
 * 3. IntersectionObserver 滚动入场动画（带同组错峰）
 * 4. Hero 界面示意的「获取图片」交互
 * 5. 页脚年份自动更新
 */
(() => {
  'use strict';

  const docEl = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // 标记 JS 可用：CSS 据此决定是否启用入场动画，避免脚本失效时内容不可见
  docEl.classList.add('js');

  const header = document.querySelector('.site-header');
  const nav = document.querySelector('.nav');
  const navToggle = document.querySelector('.nav-toggle');
  const navPanel = document.getElementById('nav-menu');
  const navLinks = Array.from(document.querySelectorAll('.nav__link'));

  /* ---------------------------------------------------------------------- */
  /* 导航：吸顶阴影 + 当前区块高亮                                          */
  /* ---------------------------------------------------------------------- */

  const spySections = ['intro', 'features', 'install']
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  let ticking = false;

  function updateOnScroll() {
    ticking = false;

    // 滚动后给导航加阴影
    if (header) {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    }

    if (!spySections.length) return;

    const offset = (header?.offsetHeight || 64) + 90;
    let currentId = '';

    for (const section of spySections) {
      if (section.getBoundingClientRect().top <= offset) {
        currentId = section.id;
      }
    }

    // 页面滚到底时，把最后一个区块标为当前
    const nearBottom =
      window.innerHeight + window.scrollY >= docEl.scrollHeight - 4;
    if (nearBottom) currentId = spySections[spySections.length - 1].id;

    navLinks.forEach((link) => {
      const isActive = link.getAttribute('href') === `#${currentId}`;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function requestScrollUpdate() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(updateOnScroll);
  }

  window.addEventListener('scroll', requestScrollUpdate, { passive: true });
  window.addEventListener('resize', requestScrollUpdate);
  window.addEventListener('load', updateOnScroll);

  /* ---------------------------------------------------------------------- */
  /* 移动端菜单                                                             */
  /* ---------------------------------------------------------------------- */

  function setMenu(open) {
    if (!nav || !navToggle) return;
    nav.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  }

  function closeMenu() {
    setMenu(false);
  }

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      setMenu(!nav.classList.contains('is-open'));
    });

    // 点击菜单内的链接后关闭
    navPanel?.addEventListener('click', (event) => {
      if (event.target.closest('a')) closeMenu();
    });

    // 点击页面其他区域关闭
    document.addEventListener('click', (event) => {
      if (!nav.classList.contains('is-open')) return;
      if (nav.contains(event.target)) return;
      closeMenu();
    });

    // Esc 关闭并把焦点还给按钮
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !nav.classList.contains('is-open')) return;
      closeMenu();
      navToggle.focus();
    });

    // 进入桌面断点时复位状态
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const handleDesktop = (event) => {
      if (event.matches) closeMenu();
    };
    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', handleDesktop);
    } else if (typeof desktopQuery.addListener === 'function') {
      desktopQuery.addListener(handleDesktop);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 滚动入场动画                                                           */
  /* ---------------------------------------------------------------------- */

  const revealItems = Array.from(document.querySelectorAll('.reveal'));

  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  } else {
    // 同一父容器内的元素依次错峰出现，最多延迟 180ms
    const groups = new Map();
    revealItems.forEach((item) => {
      const parent = item.parentElement;
      const list = groups.get(parent) || [];
      list.push(item);
      groups.set(parent, list);
    });
    groups.forEach((list) => {
      list.forEach((item, index) => {
        item.style.setProperty('--reveal-delay', `${Math.min(index, 4) * 70}ms`);
      });
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 }
    );

    revealItems.forEach((item) => observer.observe(item));
  }

  /* ---------------------------------------------------------------------- */
  /* Hero 界面示意：点击「获取图片」                                        */
  /* ---------------------------------------------------------------------- */

  const demo = document.querySelector('[data-demo]');

  if (demo) {
    const demoButton = demo.querySelector('[data-demo-button]');
    const demoLabel = demo.querySelector('[data-demo-label]');
    const demoTiles = demo.querySelectorAll('.demo__tile');
    const sheet = demo.querySelector('[data-sheet]');
    let extracted = false;
    let timer = 0;

    demoButton?.addEventListener('click', () => {
      window.clearTimeout(timer);

      if (!extracted) {
        extracted = true;
        demoButton.setAttribute('aria-pressed', 'true');
        demo.classList.add('is-scanning');
        sheet?.setAttribute('aria-hidden', 'false');

        const finish = () => {
          demo.classList.remove('is-scanning');
          demo.classList.add('is-extracted');
          if (demoLabel) demoLabel.textContent = '已提取 18 张';
          // 依次点亮勾选标记，模拟选中
          demoTiles.forEach((tile, index) => {
            window.setTimeout(() => tile.classList.add('is-picked'), index * 90);
          });
        };

        if (reduceMotion.matches) finish();
        else timer = window.setTimeout(finish, 900);
      } else {
        extracted = false;
        demoButton.setAttribute('aria-pressed', 'false');
        demo.classList.remove('is-extracted', 'is-scanning');
        demo.querySelectorAll('.demo__tile.is-picked').forEach((tile) => tile.classList.remove('is-picked'));
        if (demoLabel) demoLabel.textContent = '获取图片';
        sheet?.setAttribute('aria-hidden', 'true');
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 页脚年份                                                               */
  /* ---------------------------------------------------------------------- */

  document.querySelectorAll('[data-year]').forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
})();
