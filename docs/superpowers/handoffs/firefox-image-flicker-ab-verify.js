/*
 * Firefox post-fix check.
 * Paste the entire file into the Firefox DevTools Console.
 * It is read-only and does not change page state.
 */
(function () {
  var TARGET_IMAGE_TOKEN = '/api/v1/images/7a599901-3162-4f65-891e-dda53a6b4388';
  var roots = [];

  function visit(root) {
    var elements;
    var i;
    var shadow;

    roots.push(root);
    elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (i = 0; i < elements.length; i += 1) {
      shadow = elements[i].shadowRoot;
      if (shadow) visit(shadow);
    }
  }

  function findTarget() {
    var candidates = [];
    var root;
    var images;
    var i;
    var j;
    var image;

    for (i = 0; i < roots.length; i += 1) {
      root = roots[i];
      images = root.querySelectorAll ? root.querySelectorAll('img.roundedImage') : [];
      for (j = 0; j < images.length; j += 1) candidates.push(images[j]);
    }

    // Require the image from the captured reproduction. A fallback to another
    // rounded image would make an unrelated fixture look valid.
    for (i = 0; i < candidates.length; i += 1) {
      image = candidates[i];
      if (String(image.currentSrc || image.src || '').indexOf(TARGET_IMAGE_TOKEN) !== -1) {
        return image;
      }
    }

    return null;
  }

  function inspectFixRules() {
    var root;
    var sheets;
    var rules;
    var cssText;
    var i;
    var j;
    var sheetCount = 0;
    var readableSheetCount = 0;
    var cssRuleCount = 0;
    var unreadableSheetCount = 0;
    var matches = [];

    function inspectRules(ruleList) {
      var index;
      var rule;
      var nested;
      var text;

      for (index = 0; index < ruleList.length; index += 1) {
        rule = ruleList[index];
        cssRuleCount += 1;
        text = String(rule.cssText || '');
        if (
          text.indexOf(':host([data-lumi-scrolling])') !== -1 &&
          text.indexOf('.roundedImage') !== -1 &&
          text.indexOf('transition') !== -1 &&
          text.indexOf('animation') !== -1 &&
          text.indexOf('none') !== -1
        ) {
          if (matches.length < 3) matches.push(text);
        }
        nested = rule.cssRules;
        if (nested && nested.length) inspectRules(nested);
      }
    }

    for (i = 0; i < roots.length; i += 1) {
      root = roots[i];
      sheets = root.adoptedStyleSheets || [];
      sheetCount += sheets.length;
      for (j = 0; j < sheets.length; j += 1) {
        try {
          rules = sheets[j].cssRules || [];
          readableSheetCount += 1;
          inspectRules(rules);
        } catch (error) {
          unreadableSheetCount += 1;
        }
      }
    }
    return {
      loaded: matches.length > 0,
      sheetCount: sheetCount,
      readableSheetCount: readableSheetCount,
      cssRuleCount: cssRuleCount,
      unreadableSheetCount: unreadableSheetCount,
      matches: matches,
    };
  }

  visit(document);

  (async function () {
    var target = findTarget();
    var style = target ? window.getComputedStyle(target) : null;
    var root = target ? target.getRootNode() : null;
    var host = root && root.host instanceof Element ? root.host : null;
    var ruleInfo = inspectFixRules();
    var scrollContainer = host ? host.closest('[data-chat-scroll="true"]') : null;
    var scrolling = !!(scrollContainer && scrollContainer.hasAttribute('data-scrolling'));
    var mirrorActive = !!(host && host.hasAttribute('data-lumi-scrolling'));
    var pointerOver = !!(target && target.matches && target.matches(':hover'));
    var targetExact = !!(target && String(target.currentSrc || target.src || '').indexOf(TARGET_IMAGE_TOKEN) !== -1);
    var transitionSuppressed = !!(style && style.transition === 'none');
    var animationSuppressed = !!(style && style.animation === 'none');
    var result = {
      firefox: /firefox/i.test(navigator.userAgent),
      targetFound: !!target,
      targetExact: targetExact,
      targetImageToken: target ? String(target.currentSrc || target.src || '') : null,
      ruleLoaded: ruleInfo.loaded,
      adoptedSheetCount: ruleInfo.sheetCount,
      readableSheetCount: ruleInfo.readableSheetCount,
      unreadableSheetCount: ruleInfo.unreadableSheetCount,
      cssRuleCount: ruleInfo.cssRuleCount,
      matchingRules: ruleInfo.matches,
      extensionDebugApi: typeof window.__riCompatDump === 'object',
      targetClass: target ? String(target.className || '') : null,
      targetRoot: root && root.host ? 'shadow' : (target ? 'document' : null),
      hostMirror: mirrorActive,
      rect: target
        ? [target.getBoundingClientRect().x, target.getBoundingClientRect().y, target.getBoundingClientRect().width, target.getBoundingClientRect().height]
        : null,
      transition: style ? style.transition : null,
      animation: style ? style.animation : null,
      aspectRatio: style ? style.aspectRatio : null,
      scrolling: scrolling,
      pointerOver: pointerOver,
      transitionSuppressed: transitionSuppressed,
      animationSuppressed: animationSuppressed,
      pass: /firefox/i.test(navigator.userAgent) && targetExact && !!(root && root.host) &&
        ruleInfo.loaded && scrolling && pointerOver && mirrorActive &&
        transitionSuppressed && animationSuppressed,
    };

    var servedBundle = null;
    try {
      var listResponse = await window.fetch('/api/v1/spindle', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!listResponse.ok) throw new Error('extension list HTTP ' + listResponse.status);
      var payload = await listResponse.json();
      var extensions = payload.extensions || [];
      var extension = null;
      var i;

      for (i = 0; i < extensions.length; i += 1) {
        if (extensions[i].identifier === 'lumirealm' || extensions[i].name === 'LumiRealm') {
          extension = extensions[i];
          break;
        }
      }
      if (!extension || !extension.id) {
        throw new Error('LumiRealm extension record not found in current runtime');
      }

      var extensionId = String(extension.id);
      var manifestUrl = '/api/v1/spindle/' + encodeURIComponent(extensionId) + '/manifest';
      var manifestResponse = await window.fetch(manifestUrl, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!manifestResponse.ok) throw new Error('manifest HTTP ' + manifestResponse.status);
      var manifest = await manifestResponse.json();
      var cacheKey = manifest.frontend_cache_key || '';
      var version = encodeURIComponent(String(cacheKey || 'lumirealm'));
      var url = '/api/v1/spindle/' + encodeURIComponent(extensionId) + '/frontend?v=' + version;
      var bundleResponse = await window.fetch(url, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!bundleResponse.ok) throw new Error('frontend HTTP ' + bundleResponse.status);
      var bundle = await bundleResponse.text();
      var selector = ':host([data-lumi-scrolling]) .roundedImage';
      servedBundle = {
        extensionId: extensionId,
        extensionIdentifier: extension.identifier,
        manifestCacheKey: cacheKey,
        bundleUrl: url,
        bundleBytes: bundle.length,
        selectorInServedBundle: bundle.indexOf(selector) !== -1,
        legacySelectorAbsent: bundle.indexOf(':host-context') === -1,
      };
    } catch (error) {
      servedBundle = { error: String(error) };
      result.pass = false;
    }

    console.log('[lumi-fx-ab] verification', result);
    console.log('[lumi-fx-ab] served bundle', servedBundle);
    if (!result.pass || !servedBundle || servedBundle.selectorInServedBundle !== true || servedBundle.legacySelectorAbsent !== true) {
      result.pass = false;
      console.error('[lumi-fx-ab] FAIL: reload/restart the extension and rerun while the target is in the scroll gate');
    } else {
      console.log('[lumi-fx-ab] PASS: Firefox-safe rule is served and adopted for the current target state');
    }
    return { verification: result, servedBundle: servedBundle };
  })();
})();
