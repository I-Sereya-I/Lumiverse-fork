/*
 * Firefox image-flicker A/B probe.
 * Paste this entire file into the Firefox DevTools Console.
 * The probe is diagnostic-only and is cleared by reload.
 */
(() => {
  const global = window;
  const existing = global.__lumiFxAB;
  if (existing?.stop) existing.stop();

  const state = {
    label: 'current-pointer-over',
    started: performance.now(),
    records: [],
    imageIds: new WeakMap(),
    nextImageId: 1,
    lastFrame: performance.now(),
    frameHandle: 0,
    pointer: null,
    list: null,
    observer: null,
    listenersInstalled: false,
  };

  const rootLabel = (node) => {
    const root = node?.getRootNode?.();
    if (root instanceof ShadowRoot) {
      const host = root.host;
      return `shadow:${host?.tagName?.toLowerCase() || 'unknown'}.${String(host?.className || '')}`;
    }
    return 'document';
  };

  const css = (node) => {
    try { return node ? getComputedStyle(node) : null; } catch { return null; }
  };

  const findRow = (node) => {
    let current = node;
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (current.matches?.('[data-virtual-index], [data-message-id], [data-measure-key]')) return current;
      const parent = current.parentElement;
      if (parent) {
        current = parent;
      } else {
        const root = current.getRootNode?.();
        current = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return null;
  };

  const describe = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = node.getBoundingClientRect?.();
    const style = css(node);
    const parent = node.parentElement;
    const row = node.tagName === 'IMG' ? findRow(node) : null;
    const rowRect = row?.getBoundingClientRect?.();
    let imageId;
    if (node.tagName === 'IMG') {
      imageId = state.imageIds.get(node) || `img-${state.nextImageId++}`;
      state.imageIds.set(node, imageId);
    }
    return {
      tag: node.tagName,
      className: String(node.className || ''),
      imageId,
      src: node.tagName === 'IMG' ? node.currentSrc || node.src : undefined,
      connected: node.isConnected,
      root: rootLabel(node),
      rect: rect ? [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * 10) / 10) : null,
      hover: node.matches?.(':hover') || false,
      parentHover: parent?.matches?.(':hover') || false,
      parentClass: String(parent?.className || ''),
      position: style?.position,
      transform: style?.transform,
      transition: style?.transition,
      aspectRatio: style?.aspectRatio,
      contain: style?.contain,
      opacity: style?.opacity,
      filter: style?.filter,
      row: row ? {
        virtualIndex: row.getAttribute('data-virtual-index'),
        messageId: row.getAttribute('data-message-id'),
        measureKey: row.getAttribute('data-measure-key'),
        styleMode: row.getAttribute('data-style-mode'),
        className: String(row.className || ''),
        rect: rowRect ? [rowRect.x, rowRect.y, rowRect.width, rowRect.height].map((v) => Math.round(v * 10) / 10) : null,
      } : undefined,
    };
  };

  const allImages = () => {
    const images = [...document.images];
    const visit = (root) => {
      for (const host of root.querySelectorAll?.('*') || []) {
        if (host.shadowRoot) {
          images.push(...host.shadowRoot.querySelectorAll('img'));
          visit(host.shadowRoot);
        }
      }
    };
    visit(document);
    return [...new Set(images)];
  };

  const findTargetImage = () => {
    const candidates = allImages().filter((img) => img.matches('.roundedImage'));
    const visible = candidates.filter((img) => {
      const rect = img.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= innerHeight;
    });
    const hovered = visible.find((img) => img.matches(':hover'));
    return hovered || visible[0] || candidates[0] || null;
  };

  const snapshot = (reason, extra = {}) => {
    const hovered = allImages().filter((img) => img.matches(':hover')).map(describe);
    const visible = allImages().filter((img) => {
      const rect = img.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= innerHeight;
    }).map(describe);
    state.records.push({
      t: Math.round((performance.now() - state.started) * 10) / 10,
      reason,
      label: state.label,
      scrollTop: state.list?.scrollTop ?? null,
      scrollHeight: state.list?.scrollHeight ?? null,
      clientHeight: state.list?.clientHeight ?? null,
      point: state.pointer ? {
        x: state.pointer.x,
        y: state.pointer.y,
        target: describe(document.elementFromPoint(state.pointer.x, state.pointer.y)),
      } : null,
      hoveredImages: hovered,
      visibleImages: visible,
      override: findTargetImage()?.style.getPropertyValue('aspect-ratio') || null,
      ...extra,
    });
    if (state.records.length > 20000) state.records.shift();
  };

  const onPointerMove = (event) => {
    state.pointer = { x: event.clientX, y: event.clientY };
    snapshot('pointer', { eventTarget: describe(event.target) });
  };
  const onScroll = () => snapshot('scroll');
  const onMutation = (mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target;
      snapshot('mutation', {
        mutationType: mutation.type,
        attributeName: mutation.attributeName,
        target: describe(target),
        image: describe(target?.tagName === 'IMG' ? target : target?.closest?.('img')),
        added: mutation.addedNodes.length,
        removed: mutation.removedNodes.length,
      });
    }
  };
  const frame = (now) => {
    const gap = now - state.lastFrame;
    if (gap > 32) snapshot('frame-gap', { gap: Math.round(gap * 10) / 10 });
    state.lastFrame = now;
    state.frameHandle = requestAnimationFrame(frame);
  };

  state.list = document.querySelector('[data-chat-scroll="true"]');
  state.observer = new MutationObserver(onMutation);
  state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.addEventListener('pointermove', onPointerMove, true);
  state.list?.addEventListener('scroll', onScroll, { passive: true });
  state.listenersInstalled = true;
  state.frameHandle = requestAnimationFrame(frame);
  snapshot('start');

  const api = {
    state,
    find: () => {
      const image = findTargetImage();
      console.log('[lumi-fx-ab] target', describe(image));
      return image;
    },
    label: (value) => {
      state.label = String(value || 'run');
      console.log('[lumi-fx-ab] label:', state.label);
      return state.label;
    },
    setAspect: (ratio = '1 / 1') => {
      const image = findTargetImage();
      if (!image) throw new Error('No visible .roundedImage found. Hover the exact image, then retry.');
      state.label = 'aspect-override';
      image.style.setProperty('aspect-ratio', ratio, 'important');
      console.log(`[lumi-fx-ab] temporary aspect-ratio override: ${ratio}`, describe(image));
      snapshot('override-applied');
      return image;
    },
    clearAspect: () => {
      for (const image of allImages().filter((candidate) => candidate.matches('.roundedImage'))) {
        image.style.removeProperty('aspect-ratio');
      }
      console.log('[lumi-fx-ab] temporary aspect-ratio override cleared');
      snapshot('override-cleared');
    },
    report: (reason = 'flicker-manual') => {
      snapshot(reason);
      console.log('[lumi-fx-ab]', state.records.at(-1));
      return state.records.at(-1);
    },
    dump: () => {
      const payload = {
        meta: {
          href: location.href,
          userAgent: navigator.userAgent,
          label: state.label,
          override: findTargetImage()?.style.getPropertyValue('aspect-ratio') || null,
          started: state.started,
        },
        records: state.records,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `lumi-firefox-flicker-ab-${state.label}-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      console.log('[lumi-fx-ab] downloaded', link.download);
      return payload;
    },
    stop: () => {
      cancelAnimationFrame(state.frameHandle);
      if (state.listenersInstalled) {
        window.removeEventListener('pointermove', onPointerMove, true);
        state.list?.removeEventListener('scroll', onScroll);
      }
      state.observer?.disconnect();
      console.log('[lumi-fx-ab] stopped; reload to clear temporary styles');
    },
    restart: (label = 'current-pointer-over') => {
      api.stop();
      location.reload();
      // The reload intentionally clears the probe. Paste this file again for a new run.
      console.log(`[lumi-fx-ab] reload requested for ${label}; paste this script again after reload`);
    },
  };

  global.__lumiFxAB = api;
  global.lumiFxABFind = api.find;
  global.lumiFxABLabel = api.label;
  global.lumiFxABSetAspect = api.setAspect;
  global.lumiFxABClearAspect = api.clearAspect;
  global.lumiFxABReport = api.report;
  global.lumiFxABDump = api.dump;
  global.lumiFxABStop = api.stop;
  console.log('[lumi-fx-ab] installed. Commands: lumiFxABFind(), lumiFxABLabel("name"), lumiFxABSetAspect(), lumiFxABReport(), lumiFxABDump(), lumiFxABStop()');
})();
