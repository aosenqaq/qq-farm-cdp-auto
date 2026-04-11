(() => {
  const G = globalThis;
  const cc = G.cc || (G.GameGlobal && G.GameGlobal.cc);
  if (!cc) throw new Error('cc not found');

  const doc = (G.GameGlobal && G.GameGlobal.document) || G.document;
  const canvas = (cc.game && cc.game.canvas) || G.canvas || (G.GameGlobal && G.GameGlobal.canvas);
  let cachedSelfGid = null;

  function out(v) {
    try { console.dir(v); } catch (_) {}
    return v;
  }

  function wait(ms) {
    ms = Number(ms) || 0;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function rememberSelfGid(value) {
    const gid = toPositiveNumber(value);
    if (gid != null) cachedSelfGid = gid;
    return gid;
  }

  function roundNum(n) {
    return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : n;
  }

  function scene() {
    return cc.director.getScene();
  }

  function walk(node, outArr) {
    outArr = outArr || [];
    if (!node) return outArr;
    outArr.push(node);
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], outArr);
    }
    return outArr;
  }

  function fullPath(node) {
    const arr = [];
    for (let n = node; n; n = n.parent) arr.unshift(n.name || '(noname)');
    return arr.join('/');
  }

  function relativePath(node) {
    const s = scene();
    const fp = fullPath(node);
    return fp.indexOf(s.name + '/') === 0 ? fp.slice(s.name.length + 1) : fp;
  }

  function relativePathFrom(node, baseNode) {
    if (!node) return null;
    if (!baseNode) return relativePath(node);
    const full = fullPath(node);
    const base = fullPath(baseNode);
    if (full === base) return '.';
    return full.indexOf(base + '/') === 0 ? full.slice(base.length + 1) : full;
  }

  function nodeDepth(node, baseNode) {
    let depth = 0;
    for (let n = node; n && n !== baseNode; n = n.parent) depth++;
    return depth;
  }

  function findNode(path) {
    const s = scene();
    const raw = String(path || '').replace(/^\/+/, '');
    const rel = raw.indexOf(s.name + '/') === 0 ? raw.slice(s.name.length + 1) : raw;

    return (
      cc.find(rel, s) ||
      walk(s).find(n => fullPath(n) === raw) ||
      null
    );
  }

  function toNode(pathOrNode) {
    if (!pathOrNode) return null;
    return typeof pathOrNode === 'string' ? findNode(pathOrNode) : pathOrNode;
  }

  function getHandlers(btn) {
    const list = btn.clickEvents || [];
    return list.map((h, i) => ({
      index: i,
      target: h.target ? fullPath(h.target) : null,
      component: h._componentName || h.component || null,
      handler: h.handler || null,
      customEventData: h.customEventData == null ? null : h.customEventData,
      text: (h.target ? h.target.name : '??') + '::' + (h._componentName || h.component) + '.' + h.handler + '(' + (h.customEventData || '') + ')'
    }));
  }

  function componentNames(node) {
    return (node.components || []).map(c => {
      return c && c.constructor ? c.constructor.name : String(c);
    });
  }

  function allButtons(opts) {
    opts = opts || {};
    const activeOnly = !!opts.activeOnly;

    return walk(scene())
      .map(node => ({ node, btn: node.getComponent(cc.Button) }))
      .filter(x => !!x.btn)
      .filter(x => !activeOnly || x.node.activeInHierarchy)
      .map(({ node, btn }) => ({
        path: fullPath(node),
        relativePath: relativePath(node),
        active: !!node.activeInHierarchy,
        interactable: !!btn.interactable,
        enabledInHierarchy: !!btn.enabledInHierarchy,
        handlers: getHandlers(btn).map(x => x.text)
      }));
  }

  function dumpButtons(keyword, opts) {
    keyword = String(keyword || '').toLowerCase();
    const list = allButtons(opts).filter(x => {
      if (!keyword) return true;
      if (x.path.toLowerCase().indexOf(keyword) >= 0) return true;
      if (x.relativePath.toLowerCase().indexOf(keyword) >= 0) return true;
      for (let i = 0; i < x.handlers.length; i++) {
        if (x.handlers[i].toLowerCase().indexOf(keyword) >= 0) return true;
      }
      return false;
    });
    return out(list);
  }

  function firstComponent(root, Ctor) {
    const nodes = walk(root);
    for (let i = 0; i < nodes.length; i++) {
      const c = nodes[i].getComponent(Ctor);
      if (c) return c;
    }
    return null;
  }

  function getCamera() {
    return cc.Camera.main || firstComponent(scene(), cc.Camera);
  }

  function getNodeCenterWorld(node) {
    const ui = node.getComponent(cc.UITransform);
    if (ui && typeof ui.getBoundingBoxToWorld === 'function') {
      const box = ui.getBoundingBoxToWorld();
      return new cc.Vec3(box.x + box.width / 2, box.y + box.height / 2, 0);
    }
    const p = node.worldPosition || node.position || { x: 0, y: 0, z: 0 };
    return new cc.Vec3(p.x || 0, p.y || 0, p.z || 0);
  }

  function worldToClient(world, camera) {
    camera = camera || getCamera();
    if (!camera) throw new Error('Camera not found');

    const dpr = G.devicePixelRatio || 1;
    const screen = new cc.Vec3();
    camera.worldToScreen(screen, world);

    return {
      x: roundNum(screen.x / dpr),
      y: roundNum((cc.game.canvas.height - screen.y) / dpr)
    };
  }

  function nodeToClient(pathOrNode) {
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Node not found: ' + pathOrNode);
    return worldToClient(getNodeCenterWorld(node));
  }

  function getViewportInfo() {
    const dpr = G.devicePixelRatio || 1;
    let width = canvas && typeof canvas.width === 'number' ? canvas.width / dpr : null;
    let height = canvas && typeof canvas.height === 'number' ? canvas.height / dpr : null;

    if ((!width || !height) && cc.view && typeof cc.view.getVisibleSize === 'function') {
      try {
        const visible = cc.view.getVisibleSize();
        if (visible) {
          width = width || Number(visible.width) || null;
          height = height || Number(visible.height) || null;
        }
      } catch (_) {}
    }

    if ((!width || !height) && cc.winSize) {
      width = width || Number(cc.winSize.width) || null;
      height = height || Number(cc.winSize.height) || null;
    }

    return {
      width: roundNum(width || 0),
      height: roundNum(height || 0),
      dpr
    };
  }

  function getNodeScreenRect(pathOrNode, opts) {
    opts = opts || {};
    const node = toNode(pathOrNode);
    if (!node || !node.getComponent) return null;

    const ui = node.getComponent(cc.UITransform);
    if (!ui || typeof ui.getBoundingBoxToWorld !== 'function') return null;

    let box = null;
    try {
      box = ui.getBoundingBoxToWorld();
    } catch (_) {
      box = null;
    }
    if (!box || !isFinite(box.width) || !isFinite(box.height)) return null;

    let topLeft = null;
    let bottomRight = null;
    try {
      topLeft = worldToClient(new cc.Vec3(box.x, box.y + box.height, 0), opts.camera);
      bottomRight = worldToClient(new cc.Vec3(box.x + box.width, box.y, 0), opts.camera);
    } catch (_) {
      return null;
    }

    const left = roundNum(Math.min(topLeft.x, bottomRight.x));
    const right = roundNum(Math.max(topLeft.x, bottomRight.x));
    const top = roundNum(Math.min(topLeft.y, bottomRight.y));
    const bottom = roundNum(Math.max(topLeft.y, bottomRight.y));
    const width = roundNum(Math.max(0, right - left));
    const height = roundNum(Math.max(0, bottom - top));

    return {
      left,
      top,
      right,
      bottom,
      width,
      height,
      centerX: roundNum(left + width / 2),
      centerY: roundNum(top + height / 2)
    };
  }

  function describeNode(node, opts) {
    opts = opts || {};
    const baseNode = opts.baseNode || null;
    const camera = opts.camera || null;
    const ui = node.getComponent(cc.UITransform);
    const btn = node.getComponent(cc.Button);
    const pos = node.position || { x: 0, y: 0, z: 0 };
    const world = node.worldPosition || { x: 0, y: 0, z: 0 };

    let screen = null;
    try {
      screen = worldToClient(getNodeCenterWorld(node), camera || undefined);
    } catch (_) {}

    return {
      path: fullPath(node),
      relativePath: relativePathFrom(node, baseNode),
      name: node.name || '',
      active: !!node.active,
      activeInHierarchy: !!node.activeInHierarchy,
      depth: nodeDepth(node, baseNode),
      childCount: (node.children && node.children.length) || 0,
      siblingIndex: typeof node.getSiblingIndex === 'function' ? node.getSiblingIndex() : null,
      layer: node.layer == null ? null : node.layer,
      position: {
        x: roundNum(pos.x || 0),
        y: roundNum(pos.y || 0),
        z: roundNum(pos.z || 0)
      },
      worldPosition: {
        x: roundNum(world.x || 0),
        y: roundNum(world.y || 0),
        z: roundNum(world.z || 0)
      },
      screen,
      size: ui ? {
        width: roundNum(ui.width),
        height: roundNum(ui.height),
        anchorX: roundNum(ui.anchorX),
        anchorY: roundNum(ui.anchorY)
      } : null,
      components: componentNames(node),
      button: btn ? {
        interactable: !!btn.interactable,
        enabledInHierarchy: !!btn.enabledInHierarchy,
        handlers: getHandlers(btn)
      } : null
    };
  }

  function buttonInfo(path) {
    const node = findNode(path);
    if (!node) throw new Error('Node not found: ' + path);

    const btn = node.getComponent(cc.Button);
    if (!btn) throw new Error('Button component not found: ' + fullPath(node));

    return out({
      path: fullPath(node),
      relativePath: relativePath(node),
      active: !!node.activeInHierarchy,
      components: componentNames(node),
      handlers: getHandlers(btn)
    });
  }

  function nodeInfo(pathOrNode) {
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Node not found: ' + pathOrNode);

    return out({
      ...describeNode(node),
      componentDetails: (node.components || []).map((comp, index) => ({
        index,
        name: comp && comp.constructor ? comp.constructor.name : String(comp),
        enabled: comp && comp.enabled != null ? !!comp.enabled : null
      }))
    });
  }

  function triggerButton(path, index) {
    index = index || 0;

    const node = findNode(path);
    if (!node) throw new Error('Node not found: ' + path);

    const btn = node.getComponent(cc.Button);
    if (!btn) throw new Error('Button component not found: ' + fullPath(node));

    const h = btn.clickEvents && btn.clickEvents[index];
    if (!h) throw new Error('No clickEvents on: ' + fullPath(node));

    const target = h.target || node;
    const compName = h._componentName || h.component;
    const comp = target.getComponent(compName);
    if (!comp) throw new Error('Component not found: ' + compName + ' on ' + fullPath(target));

    const fn = comp[h.handler];
    if (typeof fn !== 'function') throw new Error('Handler not found: ' + h.handler);

    const evt = {
      type: 'click',
      target: node,
      currentTarget: node
    };

    const ret =
      h.customEventData !== undefined && h.customEventData !== ''
        ? fn.call(comp, evt, h.customEventData)
        : fn.call(comp, evt);

    out({
      action: 'triggerButton',
      path: fullPath(node),
      component: compName,
      handler: h.handler,
      customEventData: h.customEventData == null ? null : h.customEventData
    });

    return ret;
  }

  function mkTouch(x, y, id) {
    x = Math.round(x);
    y = Math.round(y);
    id = id || 1;
    return {
      identifier: id,
      id: id,
      pageX: x,
      pageY: y,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      force: 1
    };
  }

  function fireTouch(type, x, y, id) {
    if (!doc) throw new Error('document/GameGlobal.document not found');
    const p = mkTouch(x, y, id);
    const ended = type === 'touchend' || type === 'touchcancel';

    doc.dispatchEvent({
      type: type,
      timeStamp: Date.now(),
      target: canvas,
      currentTarget: canvas,
      changedTouches: [p],
      touches: ended ? [] : [p],
      targetTouches: ended ? [] : [p],
      preventDefault() {},
      stopPropagation() {}
    });
  }

  function tap(x, y, hold) {
    hold = hold == null ? 32 : hold;
    fireTouch('touchstart', x, y);
    setTimeout(() => fireTouch('touchend', x, y), hold);
    return out({ action: 'tap', x: x, y: y, hold: hold });
  }

  function tapNode(pathOrNode, hold) {
    hold = hold == null ? 32 : hold;
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Node not found: ' + pathOrNode);

    const p = nodeToClient(node);
    fireTouch('touchstart', p.x, p.y);
    setTimeout(() => fireTouch('touchend', p.x, p.y), hold);

    return out({
      action: 'tapNode',
      path: fullPath(node),
      x: p.x,
      y: p.y,
      hold: hold
    });
  }

  function emitNodeTouch(pathOrNode, hold) {
    hold = hold == null ? 32 : hold;
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Node not found: ' + pathOrNode);

    const btn = safeCall(function () {
      if (node.getComponent) return node.getComponent(cc.Button);
      return null;
    }, null);
    if (btn && typeof btn._onTouchEnded === 'function') {
      const p = nodeToClient(node);
      const evt = {
        type: 'touchend',
        target: node,
        currentTarget: node,
        getLocation: function () { return { x: p.x, y: p.y }; },
        getUILocation: function () { return { x: p.x, y: p.y }; },
        stopPropagation: function () {},
        preventDefault: function () {},
      };
      safeCall(function () { btn._onTouchEnded(evt); }, null);
      return out({
        action: 'emitNodeTouch',
        path: fullPath(node),
        hold: hold,
        via: 'button._onTouchEnded',
      });
    }

    const eventType = cc && cc.Node && cc.Node.EventType ? cc.Node.EventType : {};
    const startType = eventType.TOUCH_START || 'touch-start';
    const endType = eventType.TOUCH_END || 'touch-end';
    const event = {
      type: startType,
      target: node,
      currentTarget: node,
      touch: null,
      touches: [],
      changedTouches: [],
      getLocation: function () {
        const p = nodeToClient(node);
        return { x: p.x, y: p.y };
      },
      getUILocation: function () {
        const p = nodeToClient(node);
        return { x: p.x, y: p.y };
      },
      stopPropagation: function () {},
      preventDefault: function () {},
    };

    safeCall(function () {
      if (typeof node.emit === 'function') node.emit(startType, event);
      return true;
    }, null);
    setTimeout(function () {
      const endEvent = Object.assign({}, event, { type: endType });
      safeCall(function () {
        if (typeof node.emit === 'function') node.emit(endType, endEvent);
        return true;
      }, null);
    }, hold);

    return out({
      action: 'emitNodeTouch',
      path: fullPath(node),
      hold: hold,
    });
  }

  function invokeManagerToolTouch(manager, node) {
    if (!manager || !node) return false;
    const payload = { node: node, target: node, currentTarget: node };
    if (typeof manager.onToolInteractionNodeTouchStart === 'function') {
      safeCall(function () { return manager.onToolInteractionNodeTouchStart(payload); }, null);
    }
    if (typeof manager.onToolInteractionNodeTouchEnd === 'function') {
      safeCall(function () { return manager.onToolInteractionNodeTouchEnd(payload); }, null);
    }
    return true;
  }

  function invokeManagerLandTouch(manager, node) {
    if (!manager || !node) return false;
    const payload = { node: node, target: node, currentTarget: node };
    if (typeof manager.onInteractionNodeTouchStart === 'function') {
      safeCall(function () { return manager.onInteractionNodeTouchStart(payload); }, null);
    }
    if (typeof manager.onInteractionNodeTouchEnd === 'function') {
      safeCall(function () { return manager.onInteractionNodeTouchEnd(payload); }, null);
    }
    return true;
  }

  function smartClick(path, index) {
    index = index || 0;
    const node = findNode(path);
    if (!node) throw new Error('Node not found: ' + path);

    const btn = node.getComponent(cc.Button);
    if (btn && btn.clickEvents && btn.clickEvents.length > 0) {
      return triggerButton(path, index);
    }
    return tapNode(path);
  }

  function findFarmRoot(pathOrNode) {
    const direct = toNode(pathOrNode);
    if (direct) return direct;

    const s = scene();
    const candidates = [
      'root/scene/farm_scene_v3',
      'startup/root/scene/farm_scene_v3',
      'root/scene/farm_scene',
      'startup/root/scene/farm_scene'
    ];

    for (let i = 0; i < candidates.length; i++) {
      const node = cc.find(candidates[i], s);
      if (node) return node;
    }

    return walk(s).find(n => n.name === 'farm_scene_v3' || n.name === 'farm_scene') || null;
  }

  function findGridOrigin(pathOrNode) {
    const direct = toNode(pathOrNode);
    if (direct) return direct;

    const root = findFarmRoot();
    if (!root) return null;

    const candidates = [
      'Scaled/Rotate/GridOrigin',
      'root/scene/farm_scene_v3/Scaled/Rotate/GridOrigin',
      'startup/root/scene/farm_scene_v3/Scaled/Rotate/GridOrigin'
    ];

    for (let i = 0; i < candidates.length; i++) {
      const node = findNode(candidates[i]);
      if (node) return node;
    }

    return walk(root).find(n => n.name === 'GridOrigin') || null;
  }

  function findPlantOrigin(pathOrNode) {
    const direct = toNode(pathOrNode);
    if (direct) return direct;

    const root = findFarmRoot();
    if (!root) return null;

    const candidates = [
      'PlantOrigin',
      'root/scene/farm_scene_v3/PlantOrigin',
      'startup/root/scene/farm_scene_v3/PlantOrigin'
    ];

    for (let i = 0; i < candidates.length; i++) {
      const node = findNode(candidates[i]);
      if (node) return node;
    }

    return walk(root).find(n => n.name === 'PlantOrigin') || null;
  }

  function findComponentByName(node, compName) {
    const list = (node && node.components) || [];
    for (let i = 0; i < list.length; i++) {
      const comp = list[i];
      const name = comp && comp.constructor ? comp.constructor.name : String(comp);
      if (name === compName) return comp;
    }
    return null;
  }

  function findFirstComponentByName(root, compName) {
    const nodes = walk(root);
    for (let i = 0; i < nodes.length; i++) {
      const comp = findComponentByName(nodes[i], compName);
      if (comp) return comp;
    }
    return null;
  }

  function scoreGridComponent(comp) {
    if (!comp || typeof comp !== 'object') return -1;
    let score = 0;
    if (typeof comp.getLandId === 'function') score += 4;
    if (typeof comp.getGridPosition === 'function') score += 3;
    if (typeof comp.checkHasPlant === 'function') score += 4;
    if (typeof comp.getSelected === 'function') score += 1;
    if (typeof comp.getInteractable === 'function') score += 1;
    if (comp.isSelected != null) score += 1;
    if (comp.isInteractable != null) score += 1;
    if (typeof comp.onClick === 'function') score += 1;
    return score;
  }

  function scorePlantComponent(comp) {
    if (!comp || typeof comp !== 'object') return -1;
    let score = 0;
    if (typeof comp.getPlantData === 'function') score += 5;
    if (comp.plantData && typeof comp.plantData === 'object') score += 4;
    if (comp.config && typeof comp.config === 'object') score += 2;
    if (typeof comp.isMature === 'function') score += 2;
    if (typeof comp.isDead === 'function') score += 2;
    if (typeof comp.canHarvest === 'function') score += 1;
    return score;
  }

  function findBestComponentByScore(node, scorer, minScore) {
    const targetNode = toNode(node);
    if (!targetNode || typeof scorer !== 'function') return null;
    const nodes = [targetNode].concat(targetNode.children || []);
    let best = null;
    let bestScore = Number(minScore) || 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const cur = nodes[i];
      const list = (cur && cur.components) || [];
      for (let j = 0; j < list.length; j += 1) {
        const comp = list[j];
        const score = Number(scorer(comp)) || 0;
        if (score > bestScore) {
          best = comp;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function findMainUIComp(pathOrNode) {
    const directNode = toNode(pathOrNode);
    if (directNode) {
      const directComp = findComponentByName(directNode, 'MainUIComp');
      if (directComp) return directComp;
    }

    const candidatePaths = [
      'startup/root/ui/LayerUI/main_ui_v2',
      'root/ui/LayerUI/main_ui_v2',
      'startup/root/ui/LayerUI',
      'root/ui/LayerUI'
    ];

    for (let i = 0; i < candidatePaths.length; i++) {
      const node = findNode(candidatePaths[i]);
      if (!node) continue;
      const comp = findComponentByName(node, 'MainUIComp') || findFirstComponentByName(node, 'MainUIComp');
      if (comp) return comp;
    }

    return findFirstComponentByName(scene(), 'MainUIComp');
  }

  function findMainMenuComp(pathOrNode) {
    const directNode = toNode(pathOrNode);
    if (directNode) {
      const directComp = findComponentByName(directNode, 'MainMenuComp');
      if (directComp) return directComp;
    }

    const mainUI = findMainUIComp(pathOrNode);
    if (mainUI && mainUI.mainMenuComp) return mainUI.mainMenuComp;

    const candidatePaths = [
      'startup/root/ui/LayerUI/main_ui_v2/Menu',
      'root/ui/LayerUI/main_ui_v2/Menu',
      'startup/root/ui/LayerUI/main_ui_v2',
      'root/ui/LayerUI/main_ui_v2'
    ];

    for (let i = 0; i < candidatePaths.length; i++) {
      const node = findNode(candidatePaths[i]);
      if (!node) continue;
      const comp = findComponentByName(node, 'MainMenuComp') || findFirstComponentByName(node, 'MainMenuComp');
      if (comp) return comp;
    }

    return findFirstComponentByName(scene(), 'MainMenuComp');
  }

  function getNodeTextList(pathOrNode, opts) {
    opts = opts || {};
    const node = toNode(pathOrNode);
    if (!node) return [];

    const maxDepth = opts.maxDepth == null ? 3 : Number(opts.maxDepth);
    const texts = [];
    const seen = new Set();

    function visit(cur, depth) {
      if (!cur || depth > maxDepth) return;

      const label = cc.Label && cur.getComponent ? cur.getComponent(cc.Label) : null;
      const text = label && typeof label.string === 'string' ? label.string.trim() : '';
      if (text && !seen.has(text)) {
        seen.add(text);
        texts.push(text);
      }

      const children = cur.children || [];
      for (let i = 0; i < children.length; i++) {
        visit(children[i], depth + 1);
      }
    }

    visit(node, 0);
    return texts;
  }

  function slimButtonInfo(item) {
    return {
      path: item.path,
      relativePath: item.relativePath,
      active: item.active,
      interactable: item.interactable,
      handlers: item.handlers
    };
  }

  function findButtonsByKeywords(keyword, opts) {
    opts = opts || {};
    const keywords = normalizeKeywords(keyword);
    return allButtons({ activeOnly: !!opts.activeOnly }).filter(item => {
      return matchesKeywords([item.path, item.relativePath].concat(item.handlers || []), keywords);
    });
  }

  function toPositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function normalizeText(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalizeMatchText(value) {
    return normalizeText(value).replace(/\s+/g, '').toLowerCase();
  }

  function unwrapModuleNamespace(mod) {
    if (!mod || typeof mod !== 'object') return null;
    const queue = [mod];
    const seen = new Set();

    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      if (
        cur.GlobalData ||
        cur.FarmUtil ||
        cur.smc ||
        cur.oops ||
        cur.selfModel ||
        cur.curWatchFarmGid != null
      ) {
        return cur;
      }

      if (cur.namespace && typeof cur.namespace === 'object') queue.push(cur.namespace);
      if (cur.module && typeof cur.module === 'object') queue.push(cur.module);
      if (cur.exports && typeof cur.exports === 'object') queue.push(cur.exports);
      if (cur.default && typeof cur.default === 'object') queue.push(cur.default);
    }

    return null;
  }

  function getSystemModule(moduleIds) {
    const ids = Array.isArray(moduleIds) ? moduleIds : [moduleIds];
    const systems = [
      G.System,
      G.SystemJS,
      G.__system__,
      G.GameGlobal && G.GameGlobal.System,
      G.GameGlobal && G.GameGlobal.SystemJS
    ].filter(Boolean);

    for (let s = 0; s < systems.length; s++) {
      const sys = systems[s];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const getters = [
          () => typeof sys.get === 'function' ? sys.get(id) : null,
          () => sys.registry && typeof sys.registry.get === 'function' ? sys.registry.get(id) : null,
          () => sys._loader && sys._loader.modules
            ? (typeof sys._loader.modules.get === 'function' ? sys._loader.modules.get(id) : sys._loader.modules[id])
            : null,
          () => sys._loader && sys._loader.moduleRecords
            ? (typeof sys._loader.moduleRecords.get === 'function' ? sys._loader.moduleRecords.get(id) : sys._loader.moduleRecords[id])
            : null
        ];

        for (let gIndex = 0; gIndex < getters.length; gIndex++) {
          let raw = null;
          try {
            raw = getters[gIndex]();
          } catch (_) {
            raw = null;
          }
          const ns = unwrapModuleNamespace(raw);
          if (ns) {
            return {
              moduleId: id,
              namespace: ns
            };
          }
        }
      }
    }

    return null;
  }

  function findSystemModuleExport(moduleIds, exportNames) {
    const ids = Array.isArray(moduleIds) ? moduleIds : [moduleIds];
    const names = Array.isArray(exportNames) ? exportNames : [exportNames];
    const systems = [
      G.System,
      G.SystemJS,
      G.__system__,
      G.GameGlobal && G.GameGlobal.System,
      G.GameGlobal && G.GameGlobal.SystemJS
    ].filter(Boolean);

    function scan(raw) {
      const queue = [raw];
      const seen = new Set();

      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur || (typeof cur !== 'object' && typeof cur !== 'function') || seen.has(cur)) continue;
        seen.add(cur);

        for (let i = 0; i < names.length; i++) {
          const name = names[i];
          if (cur[name] != null) {
            return {
              exportName: name,
              namespace: cur,
              value: cur[name]
            };
          }
        }

        if (cur.namespace != null) queue.push(cur.namespace);
        if (cur.module != null) queue.push(cur.module);
        if (cur.exports != null) queue.push(cur.exports);
        if (cur.default != null) queue.push(cur.default);
      }

      return null;
    }

    for (let s = 0; s < systems.length; s++) {
      const sys = systems[s];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const getters = [
          () => typeof sys.get === 'function' ? sys.get(id) : null,
          () => sys.registry && typeof sys.registry.get === 'function' ? sys.registry.get(id) : null,
          () => sys._loader && sys._loader.modules
            ? (typeof sys._loader.modules.get === 'function' ? sys._loader.modules.get(id) : sys._loader.modules[id])
            : null,
          () => sys._loader && sys._loader.moduleRecords
            ? (typeof sys._loader.moduleRecords.get === 'function' ? sys._loader.moduleRecords.get(id) : sys._loader.moduleRecords[id])
            : null
        ];

        for (let gIndex = 0; gIndex < getters.length; gIndex++) {
          let raw = null;
          try {
            raw = getters[gIndex]();
          } catch (_) {
            raw = null;
          }
          const match = scan(raw);
          if (match) {
            return {
              moduleId: id,
              namespace: match.namespace,
              exportName: match.exportName,
              value: match.value
            };
          }
        }
      }
    }

    return null;
  }

  function getFriendManagerRuntime() {
    const candidates = [
      { source: 'globalThis.FriendManager', value: G.FriendManager },
      { source: 'GameGlobal.FriendManager', value: G.GameGlobal && G.GameGlobal.FriendManager }
    ];

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const FriendManager = item.value && item.value.FriendManager ? item.value.FriendManager : item.value;
      if (!FriendManager) continue;
      let manager = null;
      try {
        manager = FriendManager.ins || FriendManager._instance || null;
      } catch (_) {
        manager = FriendManager._instance || null;
      }
      return {
        source: item.source,
        FriendManager,
        manager
      };
    }

    const resolved = findSystemModuleExport(
      ['chunks:///_virtual/FriendManager.ts', './FriendManager.ts'],
      'FriendManager'
    );
    if (!resolved || !resolved.value) return null;

    let manager = null;
    try {
      manager = resolved.value.ins || resolved.value._instance || null;
    } catch (_) {
      manager = resolved.value._instance || null;
    }

    return {
      source: 'System:' + resolved.moduleId,
      FriendManager: resolved.value,
      manager
    };
  }

  function getFarmUtilRuntime() {
    const candidates = [
      { source: 'globalThis.FarmUtil', value: G.FarmUtil },
      { source: 'GameGlobal.FarmUtil', value: G.GameGlobal && G.GameGlobal.FarmUtil }
    ];

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const FarmUtil = item.value && item.value.FarmUtil ? item.value.FarmUtil : item.value;
      if (!FarmUtil || typeof FarmUtil.enterFarm !== 'function') continue;
      return {
        source: item.source,
        FarmUtil
      };
    }

    const resolved = findSystemModuleExport(
      ['chunks:///_virtual/FarmUtil.ts', './FarmUtil.ts'],
      'FarmUtil'
    );
    if (!resolved || !resolved.value || typeof resolved.value.enterFarm !== 'function') return null;

    return {
      source: 'System:' + resolved.moduleId,
      FarmUtil: resolved.value
    };
  }

  function getFarmEnterReasonRuntime() {
    const candidates = [
      {
        source: 'globalThis.FarmEnterReason',
        value: G.FarmEnterReason ? { FarmEnterReason: G.FarmEnterReason } : null
      },
      {
        source: 'GameGlobal.FarmEnterReason',
        value: G.GameGlobal && G.GameGlobal.FarmEnterReason
          ? { FarmEnterReason: G.GameGlobal.FarmEnterReason }
          : null
      }
    ];

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const FarmEnterReason = item.value && item.value.FarmEnterReason ? item.value.FarmEnterReason : item.value;
      if (!FarmEnterReason) continue;
      return {
        source: item.source,
        FarmEnterReason
      };
    }

    const resolved = findSystemModuleExport(
      ['chunks:///_virtual/FarmEnum.ts', './FarmEnum.ts'],
      'FarmEnterReason'
    );
    if (!resolved || !resolved.value) return null;

    return {
      source: 'System:' + resolved.moduleId,
      FarmEnterReason: resolved.value
    };
  }

  function resolveFarmEnterReason(reason) {
    const fallback = {
      UNKNOWN: 0,
      BUBBLE: 1,
      FRIEND: 2,
      INTERACT: 3
    };

    if (typeof reason === 'number' && Number.isFinite(reason)) {
      const keys = Object.keys(fallback);
      let name = null;
      for (let i = 0; i < keys.length; i++) {
        if (fallback[keys[i]] === reason) {
          name = keys[i];
          break;
        }
      }
      return {
        name,
        value: Number(reason),
        source: 'number'
      };
    }

    const rawName = normalizeText(reason || 'FRIEND').toUpperCase();
    const runtime = getFarmEnterReasonRuntime();
    const enumObj = runtime && runtime.FarmEnterReason ? runtime.FarmEnterReason : fallback;
    const value = enumObj && enumObj[rawName] != null ? Number(enumObj[rawName]) : fallback[rawName];
    if (!Number.isFinite(value)) {
      throw new Error('Unknown FarmEnterReason: ' + reason);
    }

    return {
      name: rawName,
      value,
      source: runtime ? runtime.source : 'fallback'
    };
  }

  function getSelfGid() {
    let ownership = null;
    const watchState = readGlobalFarmWatchState();
    if (watchState) {
      if (watchState.selfGid != null) return rememberSelfGid(watchState.selfGid);
      if (watchState.isOwnFarm === true && watchState.curWatchFarmGid != null) {
        return rememberSelfGid(watchState.curWatchFarmGid);
      }
    }

    try {
      ownership = getFarmOwnership({ silent: true, allowWeakUi: true });
    } catch (_) {
      ownership = null;
    }

    if (ownership && ownership.farmType === 'own' && ownership.evidence) {
      const evidence = ownership.evidence;
      const currentUserGid = rememberSelfGid(evidence.farmModel && evidence.farmModel.currentUserGid);
      if (currentUserGid != null) return currentUserGid;

      const watchGid = rememberSelfGid(evidence.globalFarmWatch && evidence.globalFarmWatch.curWatchFarmGid);
      if (watchGid != null) return watchGid;
    }

    return cachedSelfGid;
  }

  async function waitForSelfGid(opts) {
    opts = opts || {};
    const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 0);
    const intervalMs = Math.max(50, Number(opts.intervalMs) || 100);
    const deadlineAt = Date.now() + timeoutMs;

    while (true) {
      const gid = getSelfGid();
      if (gid != null) return gid;
      if (timeoutMs <= 0 || Date.now() >= deadlineAt) return null;
      await wait(Math.min(intervalMs, Math.max(0, deadlineAt - Date.now())));
    }
  }

  function readGlobalFarmWatchState() {
    const candidates = [
      { source: 'globalThis.GlobalData', value: G.GlobalData },
      { source: 'GameGlobal.GlobalData', value: G.GameGlobal && G.GameGlobal.GlobalData }
    ];

    const systemResolved = getSystemModule([
      'chunks:///_virtual/GlobalData.ts',
      './GlobalData.ts'
    ]);
    if (systemResolved) {
      candidates.push({
        source: 'System:' + systemResolved.moduleId,
        value: systemResolved.namespace
      });
    }

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      const ns = unwrapModuleNamespace(item.value);
      const globalData = ns && ns.GlobalData ? ns.GlobalData : ns;
      if (!globalData || typeof globalData !== 'object') continue;

      const selfGid = toPositiveNumber(globalData.selfModel && globalData.selfModel.gid);
      const curWatchFarmGid = toPositiveNumber(globalData.curWatchFarmGid);
      if (selfGid == null && curWatchFarmGid == null) continue;

      if (selfGid != null) rememberSelfGid(selfGid);

      return {
        source: item.source,
        selfGid,
        curWatchFarmGid,
        ready: selfGid != null && curWatchFarmGid != null,
        isOwnFarm: selfGid != null && curWatchFarmGid != null ? selfGid === curWatchFarmGid : null
      };
    }

    return null;
  }

  function getGlobalDataSnapshot() {
    const candidates = [
      { source: 'globalThis.GlobalData', value: G.GlobalData },
      { source: 'GameGlobal.GlobalData', value: G.GameGlobal && G.GameGlobal.GlobalData }
    ];

    const systemResolved = getSystemModule([
      'chunks:///_virtual/GlobalData.ts',
      './GlobalData.ts'
    ]);
    if (systemResolved) {
      candidates.push({
        source: 'System:' + systemResolved.moduleId,
        value: systemResolved.namespace
      });
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const item = candidates[i];
      const ns = unwrapModuleNamespace(item.value);
      const globalData = ns && ns.GlobalData ? ns.GlobalData : ns;
      if (!globalData || typeof globalData !== 'object') continue;
      return {
        source: item.source,
        globalData,
        selfModel: globalData.selfModel && typeof globalData.selfModel === 'object' ? globalData.selfModel : null,
        userModel: globalData.userModel && typeof globalData.userModel === 'object' ? globalData.userModel : null
      };
    }

    return null;
  }

  function classifyOwnershipByUiFallback(evidence) {
    const hasWarehouseButton =
      !!(evidence.warehouseButton && evidence.warehouseButton.active) ||
      !!(evidence.activeWarehouseButtons && evidence.activeWarehouseButtons.count > 0);
    const hasBackHomeButton =
      !!(evidence.backHomeButton && evidence.backHomeButton.active) ||
      !!(evidence.activeBackHomeButtons && evidence.activeBackHomeButtons.count > 0);
    const hasVisitNode = !!(evidence.visitNode && evidence.visitNode.active);
    const hasSourceNode = !!(evidence.sourceNode && evidence.sourceNode.active);
    const ownNavStrong = hasWarehouseButton || hasSourceNode;
    const friendNavStrong = hasBackHomeButton || hasVisitNode;
    const ownStrong =
      (hasWarehouseButton ? 3 : 0) +
      (hasSourceNode ? 1 : 0) +
      (evidence.shareButton && evidence.shareButton.active ? 1 : 0);
    const friendStrong =
      (hasBackHomeButton ? 3 : 0) +
      (hasVisitNode ? 1 : 0);

    if (ownNavStrong && !friendNavStrong) {
      return {
        farmType: 'own',
        confidence: 0.76,
        ownStrong,
        friendStrong,
        source: 'ui_nav'
      };
    }

    if (friendNavStrong && !ownNavStrong) {
      return {
        farmType: 'friend',
        confidence: 0.76,
        ownStrong,
        friendStrong,
        source: 'ui_nav'
      };
    }

    if ((ownStrong >= 3 && friendStrong === 0) || (ownStrong >= 4 && friendStrong <= 1)) {
      return {
        farmType: 'own',
        confidence: ownStrong >= 4 ? 0.72 : 0.62,
        ownStrong,
        friendStrong,
        source: 'ui_consensus'
      };
    }

    if ((friendStrong >= 3 && ownStrong === 0) || (friendStrong >= 4 && ownStrong <= 1)) {
      return {
        farmType: 'friend',
        confidence: friendStrong >= 4 ? 0.72 : 0.62,
        ownStrong,
        friendStrong,
        source: 'ui_consensus'
      };
    }

    return null;
  }

  function getFarmOwnership(opts) {
    opts = opts || {};

    const evidence = {};
    let modelReady = false;
    let landReady = false;
    let oneClickReady = false;
    let globalReady = false;
    const allowWeakUi = !!opts.allowWeakUi;

    const mainUI = findMainUIComp(opts.path);
    if (mainUI) {
      evidence.mainUI = {
        nodePath: mainUI.node ? fullPath(mainUI.node) : null
      };

      let farmModel = null;
      if (typeof mainUI.getFarmEntity === 'function') {
        try {
          const entity = mainUI.getFarmEntity();
          farmModel = entity && entity.FarmModel ? entity.FarmModel : null;
        } catch (_) {}
      }

      if (farmModel) {
        const playerId = farmModel.player_id == null ? null : Number(farmModel.player_id);
        const currentUser = farmModel.curUserModel || null;
        let landCellCount = null;
        try {
          const cells = farmModel.land && typeof farmModel.land.getCells === 'function'
            ? farmModel.land.getCells()
            : null;
          landCellCount = Array.isArray(cells) ? cells.length : null;
        } catch (_) {}
        modelReady = Number.isFinite(playerId) && playerId > 0;
        landReady = Number.isFinite(landCellCount) && landCellCount > 0;
        evidence.farmModel = {
          playerId,
          modelReady,
          landReady,
          landCellCount,
          isOwerFarm: modelReady && typeof farmModel.isOwerFarm === 'boolean' ? !!farmModel.isOwerFarm : null,
          isInVisit: modelReady && typeof farmModel.isInVisit === 'boolean' ? !!farmModel.isInVisit : null,
          currentUserGid: currentUser && currentUser.gid != null ? currentUser.gid : null,
          currentUserName: currentUser ? currentUser.limitName || currentUser.name || null : null
        };
      }

      const visitNode = mainUI.visitNode && mainUI.visitNode.node ? mainUI.visitNode.node : mainUI.visitNode;
      if (visitNode) {
        evidence.visitNode = {
          path: fullPath(visitNode),
          active: !!visitNode.activeInHierarchy,
          trusted: false
        };
      }

      const backNode = mainUI.btnBack && mainUI.btnBack.node ? mainUI.btnBack.node : null;
      if (backNode) {
        evidence.backHomeButton = {
          path: fullPath(backNode),
          active: !!backNode.activeInHierarchy,
          texts: getNodeTextList(backNode, { maxDepth: 2 }),
          trusted: false
        };
      }

      const sourceNode = mainUI.sourceComp && mainUI.sourceComp.node ? mainUI.sourceComp.node : null;
      if (sourceNode) {
        evidence.sourceNode = {
          path: fullPath(sourceNode),
          active: !!sourceNode.activeInHierarchy,
          trusted: false
        };
      }
    }

    const mainMenu = findMainMenuComp(opts.path);
    if (mainMenu) {
      evidence.mainMenu = {
        nodePath: mainMenu.node ? fullPath(mainMenu.node) : null
      };

      const warehouseNode = mainMenu.btnWarehouse && mainMenu.btnWarehouse.node ? mainMenu.btnWarehouse.node : null;
      if (warehouseNode) {
        evidence.warehouseButton = {
          path: fullPath(warehouseNode),
          active: !!warehouseNode.activeInHierarchy,
          texts: getNodeTextList(warehouseNode, { maxDepth: 2 }),
          trusted: false
        };
      }

      const shareNode = mainMenu.btnShare && mainMenu.btnShare.node ? mainMenu.btnShare.node : null;
      if (shareNode) {
        evidence.shareButton = {
          path: fullPath(shareNode),
          active: !!shareNode.activeInHierarchy,
          trusted: false
        };
      }
    }

    let oneClick = null;
    try {
      oneClick = findOneClickManager(opts.path);
    } catch (_) {}
    if (oneClick) {
      const harvestNode = oneClick.buttons && oneClick.buttons[0] && oneClick.buttons[0].node
        ? oneClick.buttons[0].node
        : null;
      const harvestTexts = harvestNode ? getNodeTextList(harvestNode, { maxDepth: 3 }) : [];
      const cachedIsOwerFarm = typeof oneClick.cachedIsOwerFarm === 'boolean'
        ? !!oneClick.cachedIsOwerFarm
        : null;
      const hasVisibilityCache = !!(oneClick.buttonVisibilityCache && oneClick.buttonVisibilityCache.size > 0);
      oneClickReady = hasVisibilityCache;

      evidence.oneClick = {
        nodePath: oneClick.node ? fullPath(oneClick.node) : null,
        hasVisibilityCache,
        cachedIsOwerFarm,
        textTrusted: hasVisibilityCache,
        harvestButtonTexts: harvestTexts
      };
    }

    const activeWarehouseButtons = findButtonsByKeywords(['openWarehouse', 'btn_warehouse'], { activeOnly: true });
    if (activeWarehouseButtons.length > 0) {
      evidence.activeWarehouseButtons = {
        trusted: false,
        count: activeWarehouseButtons.length,
        list: activeWarehouseButtons.map(slimButtonInfo)
      };
    }

    const activeBackHomeButtons = findButtonsByKeywords(['backOwerFarm'], { activeOnly: true });
    if (activeBackHomeButtons.length > 0) {
      evidence.activeBackHomeButtons = {
        trusted: false,
        count: activeBackHomeButtons.length,
        list: activeBackHomeButtons.map(slimButtonInfo)
      };
    }

    const globalFarmWatch = readGlobalFarmWatchState();
    if (globalFarmWatch) {
      evidence.globalFarmWatch = globalFarmWatch;
      globalReady = !!globalFarmWatch.ready;
    }

    const runtimeReady = modelReady || globalReady;
    let ownScore = 0;
    let friendScore = 0;
    let weakOwnScore = 0;
    let weakFriendScore = 0;
    let decisionSource = 'none';

    if (evidence.farmModel && evidence.farmModel.modelReady) {
      if (evidence.farmModel.isOwerFarm === true) ownScore += 20;
      if (evidence.farmModel.isOwerFarm === false) friendScore += 20;
      if (evidence.farmModel.isInVisit === true) friendScore += 3;
    }

    if (evidence.globalFarmWatch && evidence.globalFarmWatch.ready) {
      if (evidence.globalFarmWatch.isOwnFarm === true) ownScore += 16;
      if (evidence.globalFarmWatch.isOwnFarm === false) friendScore += 16;
    }

    const trustUi = runtimeReady || allowWeakUi;
    if (evidence.visitNode) {
      evidence.visitNode.trusted = trustUi;
      if (trustUi) {
        if (evidence.visitNode.active) friendScore += 3;
        else ownScore += 1;
      } else if (evidence.visitNode.active) {
        weakFriendScore += 1;
      }
    }

    if (evidence.backHomeButton) {
      evidence.backHomeButton.trusted = trustUi;
      if (trustUi && evidence.backHomeButton.active) friendScore += 3;
      else if (!trustUi && evidence.backHomeButton.active) weakFriendScore += 1;
    }

    if (evidence.sourceNode) {
      evidence.sourceNode.trusted = trustUi;
      if (trustUi && evidence.sourceNode.active) ownScore += 1;
      else if (!trustUi && evidence.sourceNode.active) weakOwnScore += 1;
    }

    if (evidence.warehouseButton) {
      evidence.warehouseButton.trusted = trustUi;
      if (trustUi && evidence.warehouseButton.active) ownScore += 3;
      else if (!trustUi && evidence.warehouseButton.active) weakOwnScore += 1;
    }

    if (evidence.shareButton) {
      evidence.shareButton.trusted = trustUi;
      if (trustUi && evidence.shareButton.active) ownScore += 1;
      else if (!trustUi && evidence.shareButton.active) weakOwnScore += 1;
    }

    if (evidence.activeWarehouseButtons) {
      evidence.activeWarehouseButtons.trusted = trustUi;
      if (trustUi) ownScore += 1;
      else weakOwnScore += 1;
    }

    if (evidence.activeBackHomeButtons) {
      evidence.activeBackHomeButtons.trusted = trustUi;
      if (trustUi) friendScore += 1;
      else weakFriendScore += 1;
    }

    let farmType = 'unknown';
    if (modelReady || globalReady || allowWeakUi) {
      if (ownScore > friendScore) farmType = 'own';
      else if (friendScore > ownScore) farmType = 'friend';
    }

    const scoreDiff = Math.abs(ownScore - friendScore);
    let confidence = 0;
    if (farmType === 'unknown') {
      confidence = runtimeReady ? 0.35 : 0.1;
    } else if (modelReady) {
      decisionSource = 'farm_model';
      confidence = 0.98;
    } else if (globalReady) {
      decisionSource = 'global_farm_watch';
      confidence = scoreDiff >= 12 ? 0.94 : 0.88;
    } else if (allowWeakUi) {
      decisionSource = 'weak_ui';
      confidence = scoreDiff >= 4 ? 0.55 : 0.35;
    }

    if (farmType === 'unknown') {
      const uiFallback = classifyOwnershipByUiFallback(evidence);
      if (uiFallback) {
        farmType = uiFallback.farmType;
        confidence = uiFallback.confidence;
        decisionSource = uiFallback.source;
        evidence.uiFallback = uiFallback;
      }
    }

    const payload = {
      farmType,
      isOwnFarm: farmType === 'own' ? true : farmType === 'friend' ? false : null,
      isFriendFarm: farmType === 'friend' ? true : farmType === 'own' ? false : null,
      modelReady,
      landReady,
      oneClickReady,
      globalReady,
      runtimeReady,
      confidence,
      decisionSource,
      allowWeakUi,
      scores: {
        own: ownScore,
        friend: friendScore
      },
      weakScores: {
        own: weakOwnScore,
        friend: weakFriendScore
      },
      evidence
    };

    return opts.silent ? payload : out(payload);
  }

  function getFarmEntity(opts) {
    opts = opts || {};
    const mainUI = findMainUIComp(opts.path);
    if (!mainUI || typeof mainUI.getFarmEntity !== 'function') return null;
    try {
      return mainUI.getFarmEntity() || null;
    } catch (_) {
      return null;
    }
  }

  function getFarmModel(opts) {
    const entity = getFarmEntity(opts);
    return entity && entity.FarmModel ? entity.FarmModel : null;
  }

  function inspectFarmModelRuntime(opts) {
    opts = opts || {};
    const entity = getFarmEntity(opts);
    const farmModel = entity && entity.FarmModel ? entity.FarmModel : null;
    const landStore = farmModel ? safeReadKey(farmModel, 'land') : null;
    const landCells = landStore && typeof landStore.getCells === 'function'
      ? safeCall(function () { return landStore.getCells(); }, null)
      : null;
    const sampleCell = Array.isArray(landCells) && landCells.length > 0 ? landCells[0] : null;
    return opts.silent ? {
      action: 'inspectFarmModelRuntime',
      entity: summarizeRuntimeObject(entity, 'farmEntity'),
      farmModel: summarizeRuntimeObject(farmModel, 'farmModel'),
      landStore: summarizeRuntimeObject(landStore, 'landStore'),
      sampleCell: summarizeRuntimeObject(sampleCell, 'sampleCell'),
      cellCount: Array.isArray(landCells) ? landCells.length : null,
    } : out({
      action: 'inspectFarmModelRuntime',
      entity: summarizeRuntimeObject(entity, 'farmEntity'),
      farmModel: summarizeRuntimeObject(farmModel, 'farmModel'),
      landStore: summarizeRuntimeObject(landStore, 'landStore'),
      sampleCell: summarizeRuntimeObject(sampleCell, 'sampleCell'),
      cellCount: Array.isArray(landCells) ? landCells.length : null,
    });
  }

  function inspectMainUiRuntime(opts) {
    opts = opts || {};
    const mainUI = findMainUIComp(opts.path);
    const mainMenu = findMainMenuComp(opts.path);
    const visitNode = mainUI && mainUI.visitNode && mainUI.visitNode.node ? mainUI.visitNode.node : (mainUI ? mainUI.visitNode : null);
    const backNode = mainUI && mainUI.btnBack && mainUI.btnBack.node ? mainUI.btnBack.node : null;
    const sourceNode = mainUI && mainUI.sourceComp && mainUI.sourceComp.node ? mainUI.sourceComp.node : null;
    const directEntity = mainUI ? safeReadKey(mainUI, 'farmEntity') : null;
    const directFarmModel = mainUI
      ? (safeReadKey(mainUI, 'farmModel') || safeReadKey(mainUI, 'FarmModel'))
      : null;
    const entity = getFarmEntity(opts);
    const farmModel = entity && entity.FarmModel ? entity.FarmModel : directFarmModel;
    const landStore = farmModel ? safeReadKey(farmModel, 'land') : null;
    const methodKeywords = ['farm', 'land', 'grid', 'cell', 'visit', 'own', 'model', 'user', 'data'];
    const mainUiMethodNames = filterMethodNamesByKeywords(mainUI, methodKeywords);
    const mainMenuMethodNames = filterMethodNamesByKeywords(mainMenu, methodKeywords);
    const payload = {
      action: 'inspectMainUiRuntime',
      mainUI: summarizeRuntimeObject(mainUI, 'mainUI'),
      mainUINodePath: mainUI && mainUI.node ? fullPath(mainUI.node) : null,
      mainUITexts: mainUI && mainUI.node ? getNodeTextList(mainUI.node, { maxDepth: 3 }).slice(0, 40) : [],
      mainMenu: summarizeRuntimeObject(mainMenu, 'mainMenu'),
      mainMenuNodePath: mainMenu && mainMenu.node ? fullPath(mainMenu.node) : null,
      visitNode: summarizeNodeForClick(visitNode),
      backNode: summarizeNodeForClick(backNode),
      sourceNode: summarizeNodeForClick(sourceNode),
      directEntity: summarizeRuntimeObject(directEntity, 'directEntity'),
      entity: summarizeRuntimeObject(entity, 'farmEntity'),
      directFarmModel: summarizeRuntimeObject(directFarmModel, 'directFarmModel'),
      farmModel: summarizeRuntimeObject(farmModel, 'farmModel'),
      landStore: summarizeRuntimeObject(landStore, 'landStore'),
      methodNames: {
        mainUI: mainUiMethodNames.slice(0, 80),
        mainMenu: mainMenuMethodNames.slice(0, 80),
      },
      sourcePreview: {
        getFarmEntity: getMethodSourcePreview(mainUI, 'getFarmEntity', 1200),
        getCurUserModel: getMethodSourcePreview(mainUI, 'getCurUserModel', 1000),
        refreshView: getMethodSourcePreview(mainUI, 'refreshView', 1000),
        updateData: getMethodSourcePreview(mainUI, 'updateData', 1000),
        updateView: getMethodSourcePreview(mainUI, 'updateView', 1000),
        onLoad: getMethodSourcePreview(mainUI, 'onLoad', 1000),
        onEnable: getMethodSourcePreview(mainUI, 'onEnable', 1000),
      },
      fieldSummary: {
        playerId: farmModel ? safeReadKey(farmModel, 'player_id') : null,
        isOwerFarm: farmModel ? safeReadKey(farmModel, 'isOwerFarm') : null,
        isInVisit: farmModel ? safeReadKey(farmModel, 'isInVisit') : null,
        curWatchFarmGid: mainUI ? safeReadKey(mainUI, 'curWatchFarmGid') : null,
        selfGid: mainUI ? safeReadKey(mainUI, 'gid') : null,
      },
    };
    return opts.silent ? payload : out(payload);
  }

  function inspectFarmComponentCandidates(opts) {
    opts = opts || {};
    const root = scene();
    const keywords = ['farm', 'land', 'grid', 'cell', 'visit', 'own', 'user', 'menu', 'back'];
    const interestingFields = ['visitNode', 'btnBack', 'mainMenuComp', 'sourceComp', 'curWatchFarmGid', 'farmEntity', 'farmModel', 'land', 'player_id'];
    const hits = [];
    const nodes = walk(root);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const comps = (node && node.components) || [];
      for (let j = 0; j < comps.length; j += 1) {
        const comp = comps[j];
        if (!comp || typeof comp !== 'object') continue;
        const methodNames = filterMethodNamesByKeywords(comp, keywords);
        const ownNames = safeCall(function () { return Object.getOwnPropertyNames(comp); }, []);
        const matchedFields = ownNames.filter(function (key) {
          return interestingFields.indexOf(key) >= 0;
        });
        const score =
          methodNames.length +
          matchedFields.length * 3 +
          (typeof safeReadKey(comp, 'getFarmEntity') === 'function' ? 10 : 0) +
          (safeReadKey(comp, 'visitNode') ? 3 : 0) +
          (safeReadKey(comp, 'btnBack') ? 3 : 0) +
          (safeReadKey(comp, 'mainMenuComp') ? 3 : 0);
        if (score <= 0) continue;
        hits.push({
          score: score,
          nodePath: fullPath(node),
          componentName: comp && comp.constructor ? comp.constructor.name : String(comp),
          summary: summarizeRuntimeObject(comp, 'candidate'),
          matchedFields: matchedFields,
          methodNames: methodNames.slice(0, 40),
          sourcePreview: {
            getFarmEntity: getMethodSourcePreview(comp, 'getFarmEntity', 1000),
            getCurUserModel: getMethodSourcePreview(comp, 'getCurUserModel', 800),
            updateView: getMethodSourcePreview(comp, 'updateView', 800),
            refreshView: getMethodSourcePreview(comp, 'refreshView', 800),
          },
        });
      }
    }
    hits.sort(function (a, b) { return b.score - a.score; });
    const payload = {
      action: 'inspectFarmComponentCandidates',
      scene: root ? root.name : null,
      count: hits.length,
      candidates: hits.slice(0, Math.max(5, Number(opts.limit) || 12)),
    };
    return opts.silent ? payload : out(payload);
  }

  function getPlayerProfile(opts) {
    opts = opts || {};
    installRuntimeSpies();
    const farmModel = getFarmModel(opts);
    const currentUser = farmModel && farmModel.curUserModel ? farmModel.curUserModel : null;
    const globalSnapshot = getGlobalDataSnapshot();
    const selfModel = globalSnapshot && globalSnapshot.selfModel ? globalSnapshot.selfModel : null;
    const userModel = globalSnapshot && globalSnapshot.userModel ? globalSnapshot.userModel : null;
    const systemAccount = findBestSystemAccountObject();
    const systemUser = systemAccount && systemAccount.value ? systemAccount.value : null;
    const protocolProfile = getProtocolAccountProfile();
    function collectObjects(rootObj, maxDepth) {
      const result = [];
      const queue = [{ value: rootObj, depth: 0 }];
      const seen = new Set();
      while (queue.length > 0) {
        const item = queue.shift();
        const value = item && item.value;
        const depth = item && item.depth || 0;
        if (!value || typeof value !== 'object') continue;
        if (seen.has(value)) continue;
        seen.add(value);
        result.push(value);
        if (depth >= maxDepth) continue;
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i += 1) {
          const child = value[keys[i]];
          if (child && typeof child === 'object') {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      }
      return result;
    }
    function pickFirstNumber(obj, keys, options) {
      const cfg = options || {};
      const min = cfg.min == null ? 0 : Number(cfg.min);
      if (!obj || typeof obj !== 'object') return null;
      function safeRead(target, key) {
        try {
          return target[key];
        } catch (_) {
          return undefined;
        }
      }
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = Number(safeRead(obj, key));
        if (Number.isFinite(value) && value >= min) {
          return value;
        }
      }
      return null;
    }
    function pickFromScopes(scopes, keys, options) {
      for (let i = 0; i < scopes.length; i += 1) {
        const found = pickFirstNumber(scopes[i], keys, options);
        if (found != null) return found;
      }
      return null;
    }
    const allScopes = collectObjects(currentUser, 2)
      .concat(collectObjects(selfModel, 2))
      .concat(collectObjects(userModel, 2))
      .concat(collectObjects(systemUser, 2));
    const wallet = currentUser && currentUser.wallet && typeof currentUser.wallet === 'object' ? currentUser.wallet : null;
    const assets = currentUser && currentUser.assets && typeof currentUser.assets === 'object' ? currentUser.assets : null;
    const scopes = [currentUser, selfModel, userModel, systemUser, wallet, assets].concat(allScopes).filter(Boolean);
    const selfGidHint = getSelfGid();
    function getScopeIdentity(scope) {
      if (!scope || typeof scope !== 'object') return null;
      const rawGid = safeGet(scope, 'gid');
      const rawUid = safeGet(scope, 'uid');
      const rawRoleId = safeGet(scope, 'roleId');
      const gidVal = Number(rawGid != null ? rawGid : (rawUid != null ? rawUid : rawRoleId));
      return Number.isFinite(gidVal) && gidVal > 0 ? gidVal : null;
    }
    const preferredScopes = selfGidHint != null
      ? scopes.filter(function (scope) { return getScopeIdentity(scope) === selfGidHint; })
      : [];
    const identityScopes = preferredScopes.length > 0 ? preferredScopes.concat(scopes) : scopes;
    const profile = {
      gid: null,
      name: null,
      level: null,
      plantLevel: null,
      farmMaxLandLevel: null,
      exp: null,
      nextLevelExp: null,
      playerId: farmModel && farmModel.player_id != null ? Number(farmModel.player_id) : null,
      gold: null,
      coupon: null,
      diamond: null,
      bean: null,
    };

    function safeGet(target, key) {
      if (!target || typeof target !== 'object') return undefined;
      try {
        return target[key];
      } catch (_) {
        return undefined;
      }
    }

    if (identityScopes.length > 0) {
      for (let i = 0; i < identityScopes.length; i += 1) {
        const scope = identityScopes[i];
        if (!scope || typeof scope !== 'object') continue;
        const rawGid = safeGet(scope, 'gid');
        const rawUid = safeGet(scope, 'uid');
        const rawRoleId = safeGet(scope, 'roleId');
        const gidVal = Number(rawGid != null ? rawGid : (rawUid != null ? rawUid : rawRoleId));
        if (profile.gid == null && Number.isFinite(gidVal) && gidVal > 0) {
          profile.gid = gidVal;
        }
        if (!profile.name) {
          const nameVal = normalizeText(
            safeGet(scope, 'limitName') ||
            safeGet(scope, 'name') ||
            safeGet(scope, 'nick') ||
            safeGet(scope, 'nickname') ||
            safeGet(scope, 'role_name') ||
            safeGet(scope, 'displayName')
          );
          if (nameVal) profile.name = nameVal;
        }
        if (profile.gid != null && profile.name) break;
      }

      const valueScopes = preferredScopes.length > 0 ? preferredScopes.concat(scopes) : scopes;
      profile.level = pickFromScopes(valueScopes, ['level', 'lv', 'grade', 'role_level', 'land_level', 'userLevel'], { min: 1 });
      profile.farmMaxLandLevel = pickFromScopes(valueScopes, [
        'farmMaxLandLevel',
        'farm_max_land_level',
        'maxPlantLevel',
        'maxLandLevel',
        'max_land_level',
        'farmLandLevel',
        'farm_land_level',
      ], { min: 1 });
      const plantLevel = Math.max(Number(profile.level) || 0, Number(profile.farmMaxLandLevel) || 0);
      profile.plantLevel = plantLevel > 0 ? plantLevel : null;
      profile.exp = pickFromScopes(valueScopes, ['exp', 'curExp', 'currentExp', 'role_exp', 'experience'], { min: 0 });
      profile.nextLevelExp = pickFromScopes(valueScopes, ['nextLevelExp', 'maxExp', 'next_exp', 'needExp', 'targetExp'], { min: 1 });

      profile.gold = pickFromScopes(valueScopes, [
        'gold',
        'coin',
        'coins',
        'money',
        '金币',
      ], { min: 0 });
      profile.coupon = pickFromScopes(valueScopes, [
        'coupon',
        'couponNum',
        'coupons',
        'pointCoupon',
        'ticket',
        'tickets',
        '券',
        '点券',
      ], { min: 0 });
      profile.diamond = pickFromScopes(valueScopes, [
        'diamond',
        'diamonds',
        'gem',
        'gems',
        '钻石',
      ], { min: 0 });
      profile.bean = pickFromScopes(valueScopes, [
        'bean',
        'beans',
        'goldBean',
        'goldBeans',
        'goldenBean',
        'jindou',
        '金豆',
      ], { min: 0 });
    }

    if (profile.gid == null) {
      profile.gid = getSelfGid();
    }

    if (profile.playerId == null) {
      profile.playerId = pickFromScopes(scopes, ['player_id', 'playerId', 'roleId'], { min: 1 });
    }

    if (protocolProfile) {
      if (profile.gid == null && protocolProfile.gid != null) profile.gid = protocolProfile.gid;
      if (!profile.name && protocolProfile.name) profile.name = protocolProfile.name;
      if (profile.level == null && protocolProfile.level != null) profile.level = protocolProfile.level;
      if (profile.exp == null && protocolProfile.exp != null) profile.exp = protocolProfile.exp;
      if (profile.gold == null && protocolProfile.gold != null) profile.gold = protocolProfile.gold;
      if (profile.coupon == null && protocolProfile.coupon != null) profile.coupon = protocolProfile.coupon;
      if (profile.diamond == null && protocolProfile.diamond != null) profile.diamond = protocolProfile.diamond;
      if (profile.bean == null && protocolProfile.bean != null) profile.bean = protocolProfile.bean;
    }

    const couponByItem = getItemCountById(1002);
    const beanByItem = getItemCountById(1005);
    if (couponByItem != null && (profile.coupon == null || Number(profile.coupon) <= 0)) profile.coupon = couponByItem;
    if (beanByItem != null && (profile.bean == null || Number(profile.bean) <= 0)) profile.bean = beanByItem;

    return opts.silent ? profile : out(profile);
  }

  function safeGetPlayerProfileSilent() {
    try {
      return getPlayerProfile({ silent: true });
    } catch (error) {
      return {
        gid: getSelfGid(),
        name: null,
        level: null,
        exp: null,
        nextLevelExp: null,
        playerId: null,
        gold: null,
        coupon: getItemCountById(1002),
        diamond: null,
        bean: getItemCountById(1005),
        source: "profile_error_fallback",
        error: error && error.message ? error.message : String(error),
      };
    }
  }

  function getPlayerProfileDebug(opts) {
    opts = opts || {};
    installRuntimeSpies();
    const farmModel = getFarmModel(opts);
    const currentUser = farmModel && farmModel.curUserModel ? farmModel.curUserModel : null;
    const globalSnapshot = getGlobalDataSnapshot();
    const selfModel = globalSnapshot && globalSnapshot.selfModel ? globalSnapshot.selfModel : null;
    const userModel = globalSnapshot && globalSnapshot.userModel ? globalSnapshot.userModel : null;
    const selectedSystemAccount = findBestSystemAccountObject();
    const protocolProfile = getProtocolAccountProfile();
    const protocolAccount = findBestProtocolAccountObject();
    const net = safeCall(function () { return getNetWebSocket(); }, null);
    const itemM = safeCall(function () { return getItemManager(); }, null);
    const messageBus = safeCall(function () { return getOopsMessage(); }, null);

      const payload = {
        profile: safeGetPlayerProfileSilent(),
        protocolProfile: protocolProfile || null,
        runtimeSpy: getRuntimeSpySnapshot(),
        itemDebug: getItemDebugSnapshot(),
        selfGid: getSelfGid(),
      farmOwnership: getFarmOwnership({ silent: true, allowWeakUi: true }),
      protocolAccount: protocolAccount && protocolAccount.value
        ? Object.assign(
            summarizeRuntimeObject(protocolAccount.value, 'protocolAccount'),
            { source: protocolAccount.source, score: protocolAccount.score, depth: protocolAccount.depth }
          )
        : { label: 'protocolAccount', exists: false, score: protocolAccount ? protocolAccount.score : null },
      selectedSystemAccount: selectedSystemAccount && selectedSystemAccount.value
        ? summarizeRuntimeObject(selectedSystemAccount.value, 'selectedSystemAccount')
        : { label: 'selectedSystemAccount', exists: false, score: selectedSystemAccount ? selectedSystemAccount.score : null },
      messageBus: summarizeRuntimeObject(messageBus, 'messageBus'),
      netChannels: net && net._channels && typeof net._channels === 'object'
        ? summarizeRuntimeObject(net._channels, 'netChannels')
        : { label: 'netChannels', exists: false },
      netWebSocket: summarizeRuntimeObject(net, 'netWebSocket'),
      itemManager: summarizeRuntimeObject(itemM, 'itemManager'),
      farmModel: summarizeRuntimeObject(farmModel, 'farmModel'),
      currentUser: summarizeRuntimeObject(currentUser, 'curUserModel'),
      selfModel: summarizeRuntimeObject(selfModel, 'selfModel'),
      userModel: summarizeRuntimeObject(userModel, 'userModel'),
      globalSource: globalSnapshot ? globalSnapshot.source : null,
    };

    return opts.silent ? payload : out(payload);
  }

  function scanAccountRuntimeDebug(opts) {
    opts = opts || {};

    function summarizeValue(label, value, source) {
      if (!value || typeof value !== 'object') return null;
      const keys = Object.keys(value);
      const picked = {};
      const interesting = [
        'gid', 'uid', 'player_id', 'playerId', 'roleId',
        'name', 'limitName', 'nick', 'nickname', 'role_name',
        'level', 'lv', 'grade', 'role_level',
        'gold', 'coupon', 'ticket', 'diamond', 'bean',
        'exp', 'curExp', 'currentExp', 'nextLevelExp',
        'selfModel', 'userModel', 'curUserModel', 'wallet', 'assets'
      ];
      for (let i = 0; i < interesting.length; i += 1) {
        const key = interesting[i];
        if (value[key] == null) continue;
        const cur = value[key];
        if (cur == null || typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') {
          picked[key] = cur;
        } else if (typeof cur === 'object') {
          picked[key] = { type: 'object', keys: Object.keys(cur).slice(0, 30) };
        }
      }
      return {
        label,
        source: source || null,
        keyCount: keys.length,
        keys: keys.slice(0, 80),
        picked,
      };
    }

    const results = [];
    const globals = [
      ['globalThis', G],
      ['GameGlobal', G.GameGlobal],
      ['oops', resolveOops()],
      ['netWebSocket', safeCall(function () { return getNetWebSocket(); }, null)],
      ['itemManager', safeCall(function () { return getItemManager(); }, null)],
      ['globalDataSnapshot', getGlobalDataSnapshot()],
      ['friendRuntime', getFriendManagerRuntime()]
    ];

    globals.forEach(function (item) {
      const summary = summarizeValue(item[0], item[1], item[0]);
      if (summary) results.push(summary);
    });

    const moduleSearches = [
      { ids: ['chunks:///_virtual/GlobalData.ts', './GlobalData.ts'], names: ['GlobalData', 'selfModel', 'userModel'] },
      { ids: ['chunks:///_virtual/FriendManager.ts', './FriendManager.ts'], names: ['FriendManager'] },
      { ids: ['chunks:///_virtual/FarmUtil.ts', './FarmUtil.ts'], names: ['FarmUtil'] },
      { ids: ['chunks:///_virtual/MainUI.ts', './MainUI.ts'], names: ['MainUI'] },
      { ids: ['chunks:///_virtual/UserModel.ts', './UserModel.ts'], names: ['UserModel', 'selfModel', 'userModel'] },
    ];

    moduleSearches.forEach(function (search) {
      const found = findSystemModuleExport(search.ids, search.names);
      if (!found) return;
      const summary = summarizeValue(found.exportName, found.value, 'System:' + found.moduleId);
      if (summary) results.push(summary);
    });

    const payload = {
      profile: safeGetPlayerProfileSilent(),
      selfGid: getSelfGid(),
      candidates: results,
    };
    return opts.silent ? payload : out(payload);
  }

  function scanSystemAccountCandidates(opts) {
    opts = opts || {};
    const limit = Math.max(1, Math.min(30, Number(opts.limit) || 12));
    const systems = [
      G.System,
      G.SystemJS,
      G.__system__,
      G.GameGlobal && G.GameGlobal.System,
      G.GameGlobal && G.GameGlobal.SystemJS
    ].filter(Boolean);

    const interestingKeys = [
      'gid', 'uid', 'player_id', 'playerId', 'roleId',
      'name', 'limitName', 'nick', 'nickname', 'role_name', 'displayName',
      'level', 'lv', 'grade', 'role_level', 'plantLevel', 'maxPlantLevel', 'farmMaxLandLevel', 'maxLandLevel',
      'gold', 'coin', 'money', 'coupon', 'ticket', 'diamond', 'bean',
      'exp', 'curExp', 'currentExp',
      'selfModel', 'userModel', 'curUserModel'
    ];

    function scoreObject(obj) {
      if (!obj || typeof obj !== 'object') return -1;
      let score = 0;
      for (let i = 0; i < interestingKeys.length; i += 1) {
        const key = interestingKeys[i];
        if (obj[key] == null) continue;
        score += 1;
        if (key === 'name' || key === 'limitName' || key === 'nick' || key === 'nickname') score += 2;
        if (key === 'level' || key === 'lv' || key === 'grade' || key === 'role_level') score += 2;
        if (key === 'plantLevel' || key === 'maxPlantLevel' || key === 'farmMaxLandLevel' || key === 'maxLandLevel') score += 2;
        if (key === 'gold' || key === 'coupon' || key === 'ticket' || key === 'diamond' || key === 'bean') score += 2;
        if (key === 'gid' || key === 'uid' || key === 'playerId' || key === 'player_id') score += 2;
      }
      return score;
    }

    function summarizeCandidate(moduleId, exportName, obj) {
      const picked = {};
      interestingKeys.forEach(function (key) {
        if (obj[key] == null) return;
        const value = obj[key];
        if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          picked[key] = value;
        } else if (typeof value === 'object') {
          picked[key] = { type: 'object', keys: Object.keys(value).slice(0, 20) };
        }
      });
      return {
        moduleId,
        exportName,
        score: scoreObject(obj),
        keys: Object.keys(obj).slice(0, 60),
        picked,
      };
    }

    const matches = [];
    const seenObjects = new Set();

    function scanValue(moduleId, exportName, raw) {
      const queue = [raw];
      const seenLocal = new Set();
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object' || seenLocal.has(cur) || seenObjects.has(cur)) continue;
        seenLocal.add(cur);
        seenObjects.add(cur);
        const score = scoreObject(cur);
        if (score >= 5) {
          matches.push(summarizeCandidate(moduleId, exportName, cur));
        }
        if (matches.length >= limit * 3) return;
        if (cur.namespace && typeof cur.namespace === 'object') queue.push(cur.namespace);
        if (cur.module && typeof cur.module === 'object') queue.push(cur.module);
        if (cur.exports && typeof cur.exports === 'object') queue.push(cur.exports);
        if (cur.default && typeof cur.default === 'object') queue.push(cur.default);
        const keys = Object.keys(cur).slice(0, 25);
        for (let i = 0; i < keys.length; i += 1) {
          const child = cur[keys[i]];
          if (child && typeof child === 'object') queue.push(child);
        }
      }
    }

    for (let s = 0; s < systems.length; s += 1) {
      const sys = systems[s];
      const containers = [];
      if (sys && typeof sys.entries === 'function') {
        try {
          for (const entry of sys.entries()) containers.push(entry);
        } catch (_) {}
      }
      if (sys && sys.registry && typeof sys.registry.entries === 'function') {
        try {
          for (const entry of sys.registry.entries()) containers.push(entry);
        } catch (_) {}
      }
      if (sys && sys._loader && sys._loader.modules) {
        const modules = sys._loader.modules;
        if (typeof modules.entries === 'function') {
          try {
            for (const entry of modules.entries()) containers.push(entry);
          } catch (_) {}
        } else {
          Object.keys(modules).forEach(function (key) {
            containers.push([key, modules[key]]);
          });
        }
      }

      for (let i = 0; i < containers.length; i += 1) {
        const entry = containers[i];
        const moduleId = Array.isArray(entry) ? entry[0] : null;
        const raw = Array.isArray(entry) ? entry[1] : null;
        if (!moduleId || !raw) continue;
        scanValue(String(moduleId), 'module', raw);
        if (matches.length >= limit * 3) break;
      }
      if (matches.length >= limit * 3) break;
    }

    matches.sort(function (a, b) { return b.score - a.score; });
    const payload = {
      profile: safeGetPlayerProfileSilent(),
      selfGid: getSelfGid(),
      matches: matches.slice(0, limit),
    };
    return opts.silent ? payload : out(payload);
  }

  function findBestSystemAccountObject() {
    const systems = [
      G.System,
      G.SystemJS,
      G.__system__,
      G.GameGlobal && G.GameGlobal.System,
      G.GameGlobal && G.GameGlobal.SystemJS
    ].filter(Boolean);

    const selfGid = getSelfGid();

    function objectScore(obj) {
      if (!obj || typeof obj !== 'object') return -1;
      let score = 0;
      const gid = Number(
        safeReadKey(obj, 'gid') != null ? safeReadKey(obj, 'gid') :
        (safeReadKey(obj, 'uid') != null ? safeReadKey(obj, 'uid') : safeReadKey(obj, 'playerId'))
      );
      const name = normalizeText(
        safeReadKey(obj, 'name') ||
        safeReadKey(obj, 'limitName') ||
        safeReadKey(obj, 'nick') ||
        safeReadKey(obj, 'nickname')
      );
      const level = Number(
        safeReadKey(obj, 'level') != null ? safeReadKey(obj, 'level') :
        (safeReadKey(obj, 'lv') != null ? safeReadKey(obj, 'lv') : safeReadKey(obj, 'grade'))
      );
      const gold = Number(safeReadKey(obj, 'gold'));
      const coupon = Number(
        safeReadKey(obj, 'coupon') != null ? safeReadKey(obj, 'coupon') : safeReadKey(obj, 'ticket')
      );
      const diamond = Number(safeReadKey(obj, 'diamond'));
      const bean = Number(
        safeReadKey(obj, 'goldenBean') != null ? safeReadKey(obj, 'goldenBean') : safeReadKey(obj, 'bean')
      );
      const exp = Number(
        safeReadKey(obj, 'exp') != null ? safeReadKey(obj, 'exp') : safeReadKey(obj, '_exp')
      );

      if (
        gid === 1111 &&
        name === '1111' &&
        (Number.isFinite(level) ? level : 0) <= 1 &&
        (Number.isFinite(gold) ? gold : 0) === 0 &&
        (Number.isFinite(coupon) ? coupon : 0) === 0 &&
        (Number.isFinite(diamond) ? diamond : 0) === 0 &&
        (Number.isFinite(bean) ? bean : 0) === 0 &&
        (Number.isFinite(exp) ? exp : 0) === 0
      ) {
        return -100;
      }

      if (gid > 0) score += 3;
      if (name) score += 3;
      if (Number.isFinite(level) && level >= 0) score += 3;
      if (Number.isFinite(gold) && gold >= 0) score += 3;
      if (safeReadKey(obj, 'coupon') != null || safeReadKey(obj, 'ticket') != null) score += 2;
      if (safeReadKey(obj, 'diamond') != null) score += 2;
      if (safeReadKey(obj, 'goldenBean') != null || safeReadKey(obj, 'bean') != null) score += 2;
      if (safeReadKey(obj, 'exp') != null || safeReadKey(obj, '_exp') != null || safeReadKey(obj, 'curExp') != null) score += 2;
      if (safeReadKey(obj, 'openId') != null || safeReadKey(obj, 'avatarUrl') != null || safeReadKey(obj, 'authorized_status') != null) score += 1;
      if (safeReadKey(obj, 'farmMaxLandLevel') != null || safeReadKey(obj, 'unlockSystems') != null) score += 1;
      if (selfGid != null && gid === selfGid) score += 20;
      if (safeReadKey(obj, 'plant') != null) score -= 4;
      if (safeReadKey(obj, 'rank') != null) score -= 2;
      if (safeReadKey(obj, 'inviteTime') != null || safeReadKey(obj, 'visitRefreshTime') != null) score -= 2;
      return score;
    }

    let best = null;
    const seen = new Set();

    function visit(moduleId, raw) {
      const queue = [raw];
      const localSeen = new Set();
      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object' || localSeen.has(cur) || seen.has(cur)) continue;
        localSeen.add(cur);
        seen.add(cur);
        const score = objectScore(cur);
        if (score >= 8 && (!best || score > best.score)) {
          best = { moduleId, value: cur, score };
        }
        if (cur.namespace && typeof cur.namespace === 'object') queue.push(cur.namespace);
        if (cur.module && typeof cur.module === 'object') queue.push(cur.module);
        if (cur.exports && typeof cur.exports === 'object') queue.push(cur.exports);
        if (cur.default && typeof cur.default === 'object') queue.push(cur.default);
        const keys = Object.keys(cur).slice(0, 25);
        for (let i = 0; i < keys.length; i += 1) {
          const child = cur[keys[i]];
          if (child && typeof child === 'object') queue.push(child);
        }
      }
    }

    for (let s = 0; s < systems.length; s += 1) {
      const sys = systems[s];
      const containers = [];
      if (sys && typeof sys.entries === 'function') {
        try {
          for (const entry of sys.entries()) containers.push(entry);
        } catch (_) {}
      }
      if (sys && sys.registry && typeof sys.registry.entries === 'function') {
        try {
          for (const entry of sys.registry.entries()) containers.push(entry);
        } catch (_) {}
      }
      if (sys && sys._loader && sys._loader.modules) {
        const modules = sys._loader.modules;
        if (typeof modules.entries === 'function') {
          try {
            for (const entry of modules.entries()) containers.push(entry);
          } catch (_) {}
        } else {
          Object.keys(modules).forEach(function (key) {
            containers.push([key, modules[key]]);
          });
        }
      }

      for (let i = 0; i < containers.length; i += 1) {
        const entry = containers[i];
        const moduleId = Array.isArray(entry) ? entry[0] : null;
        const raw = Array.isArray(entry) ? entry[1] : null;
        if (!moduleId || !raw) continue;
        visit(String(moduleId), raw);
      }
    }

    return best ? { ...best, selfGid } : { moduleId: null, value: null, score: -1, selfGid };
  }

  function mapFriendListItem(friend, index) {
    const plant = friend && friend.plant && typeof friend.plant === 'object' ? friend.plant : {};
    const workCounts = {
      collect: Math.max(0, Number(plant.steal_plant_num) || 0),
      water: Math.max(0, Number(plant.dry_num) || 0),
      eraseGrass: Math.max(0, Number(plant.weed_num) || 0),
      killBug: Math.max(0, Number(plant.insect_num) || 0)
    };
    const name = normalizeText(friend && friend.name);
    const remark = normalizeText(friend && friend.remark);
    const gid = toPositiveNumber(friend && friend.gid);
    const displayName = remark || name || (gid != null ? String(gid) : '');

    return {
      index,
      gid,
      name: name || null,
      remark: remark || null,
      displayName: displayName || null,
      level: friend && friend.level != null ? Number(friend.level) : null,
      gold: friend && friend.gold != null ? Number(friend.gold) : null,
      rank: friend && friend.rank != null ? Number(friend.rank) : null,
      avatar: friend && friend.avatar ? friend.avatar : null,
      isNew: !!(friend && friend.is_new),
      isFollow: !!(friend && friend.is_follow),
      authorizedStatus: friend && friend.authorized_status != null ? Number(friend.authorized_status) : null,
      visitRefreshTime: friend && friend.visitRefreshTime != null ? Number(friend.visitRefreshTime) : null,
      workCounts,
      canCollect: workCounts.collect > 0,
      needsWater: workCounts.water > 0,
      needsEraseGrass: workCounts.eraseGrass > 0,
      needsKillBug: workCounts.killBug > 0
    };
  }

  function getFriendSearchFields(item) {
    const values = [
      item && item.displayName,
      item && item.remark,
      item && item.name,
      item && item.gid != null ? String(item.gid) : ''
    ];
    const outArr = [];
    const seen = new Set();

    for (let i = 0; i < values.length; i++) {
      const text = normalizeText(values[i]);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      outArr.push(text);
    }

    return outArr;
  }

  function filterFriendEntriesByKeyword(entries, keyword) {
    const normalized = normalizeMatchText(keyword);
    if (!normalized) return entries;

    return entries.filter(entry => {
      const fields = getFriendSearchFields(entry.item);
      for (let i = 0; i < fields.length; i++) {
        if (normalizeMatchText(fields[i]).indexOf(normalized) >= 0) return true;
      }
      return false;
    });
  }

  function formatFriendMatchList(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.slice(0, 8).map(entry => {
      const item = entry && entry.item ? entry.item : entry;
      const label = item && (item.displayName || item.name || item.remark) ? (item.displayName || item.name || item.remark) : 'unknown';
      const gid = item && item.gid != null ? item.gid : '?';
      return label + '(' + gid + ')';
    }).join(', ');
  }

  /**
   * 调用 reqGameFriendsFromServer 获取好友最新植物状态（steal_plant_num, dry_num 等）。
   * reqFriendList (SyncAll) 返回的植物状态是缓存的，只有 reqGameFriendsFromServer (GetGameFriends)
   * 才能拿到服务端最新的可偷/可浇水等数据。
   * 游戏好友界面也是用 doRefreshFriendList -> reqGameFriendsFromServer 实现的。
   */
  async function refreshFriendPlantStatus(manager, timeoutMs) {
    timeoutMs = Math.max(500, Number(timeoutMs) || 2000);
    const list = typeof manager.getClientFriendList === 'function'
      ? manager.getClientFriendList()
      : manager.clientFriendList;
    if (!Array.isArray(list) || list.length === 0) return { refreshed: false, reason: 'empty_list' };

    const gids = list.map(f => f && f.gid).filter(g => g != null);
    if (gids.length === 0) return { refreshed: false, reason: 'no_gids' };

    if (typeof manager.reqGameFriendsFromServer !== 'function') {
      return { refreshed: false, reason: 'method_not_found' };
    }

    // 重置刷新页标记，允许重新请求
    if (typeof manager.resetRefreshPage === 'function') {
      try { manager.resetRefreshPage(); } catch (_) {}
    }
    if (typeof manager.resetFriendCanRefresh === 'function') {
      try { manager.resetFriendCanRefresh(); } catch (_) {}
    }

    // 直接调用 reqGameFriendsFromServer，分页发送（与游戏一致，每页50个）
    const PAGE_SIZE = manager.REFRESH_PAGE_NUM || 50;
    let pageCount = 0;
    for (let i = 0; i < gids.length; i += PAGE_SIZE) {
      const chunk = gids.slice(i, i + PAGE_SIZE);
      try {
        manager.reqGameFriendsFromServer(chunk);
        pageCount++;
      } catch (_) {}
    }

    // 等待 WebSocket 异步回调完成更新 clientFriendList
    await wait(Math.min(timeoutMs, 500 + pageCount * 200));

    return { refreshed: true, gidCount: gids.length, pages: pageCount };
  }

  function resolveFriendRuntimeContext() {
    const runtime = getFriendManagerRuntime();
    if (!runtime || !runtime.FriendManager) throw new Error('FriendManager not found');

    let manager = runtime.manager || null;
    if (!manager) {
      try {
        manager = runtime.FriendManager.ins || runtime.FriendManager._instance || null;
      } catch (_) {
        manager = runtime.FriendManager._instance || null;
      }
    }
    if (!manager) throw new Error('FriendManager instance not ready');

    return {
      runtime,
      manager
    };
  }

  function shouldRequestFriendRefresh(manager, opts) {
    if (!manager || typeof manager.reqFriendList !== 'function') return false;
    if (manager.bReqFriendListed !== true && opts.allowFetch !== false) return true;
    if (opts.refresh === true) return true;
    return false;
  }

  function buildFriendEntriesResult(runtime, manager, opts, refreshMeta) {
    refreshMeta = refreshMeta || {};
    opts = opts || {};

    if (opts.sort !== false && manager && typeof manager.sortClientFriendList === 'function') {
      try {
        manager.sortClientFriendList();
      } catch (_) {}
    }

    let rawList = [];
    try {
      rawList = opts.includeSelf
        ? (
            typeof manager.getClientFriendList === 'function'
              ? manager.getClientFriendList()
              : manager.clientFriendList
          )
        : (
            typeof manager.getClientFriendListExcludeSelf === 'function'
              ? manager.getClientFriendListExcludeSelf()
              : (
                  typeof manager.getClientFriendList === 'function'
                    ? manager.getClientFriendList()
                    : manager.clientFriendList
                )
          );
    } catch (_) {
      rawList = [];
    }
    rawList = Array.isArray(rawList) ? rawList : [];

    const watchState = readGlobalFarmWatchState();
    const selfGid = watchState && watchState.selfGid != null ? watchState.selfGid : null;
    const entries = rawList
      .map((friend, index) => ({
        raw: friend,
        item: mapFriendListItem(friend, index)
      }))
      .filter(entry => entry.item && entry.item.gid != null)
      .filter(entry => opts.includeSelf || selfGid == null || entry.item.gid !== selfGid);

    const keyword = opts.keyword != null ? opts.keyword : (opts.search != null ? opts.search : opts.query);
    const filteredEntries = keyword == null ? entries : filterFriendEntriesByKeyword(entries, keyword);

    return {
      source: runtime.source,
      manager,
      requestedRefresh: !!refreshMeta.requestedRefresh,
      refreshed: !!refreshMeta.refreshed,
      refreshError: refreshMeta.refreshError || null,
      refreshMode: refreshMeta.refreshMode || 'none',
      reqFriendListed: !!manager.bReqFriendListed,
      selfGid,
      totalCount: entries.length,
      entries: filteredEntries
    };
  }

  function getFriendEntriesSync(opts) {
    opts = opts || {};
    const ctx = resolveFriendRuntimeContext();
    const requestedRefresh = shouldRequestFriendRefresh(ctx.manager, opts);
    let refreshMode = 'none';

    // if (requestedRefresh) {
      refreshMode = 'background';
      Promise.resolve()
        .then(() => ctx.manager.reqFriendList())
        .then(() => {
          if (opts.refreshPlantStatus !== false) {
            return refreshFriendPlantStatus(ctx.manager, opts.plantRefreshTimeoutMs);
          }
        })
        .catch(() => {});
    // }

    return buildFriendEntriesResult(ctx.runtime, ctx.manager, opts, {
      requestedRefresh,
      refreshed: false,
      refreshError: null,
      refreshMode
    });
  }

  async function getFriendEntries(opts) {
    opts = opts || {};
    const ctx = resolveFriendRuntimeContext();
    const requestedRefresh = shouldRequestFriendRefresh(ctx.manager, opts);
    let refreshed = false;
    let refreshError = null;
    let refreshMode = 'none';
    let plantRefreshResult = null;

    // if (requestedRefresh) {
      refreshMode = 'awaited';
      try {
        // 1. reqFriendList (SyncAll) 拉取基本好友列表
        await ctx.manager.reqFriendList();
        refreshed = true;
      } catch (e) {
        refreshError = e && e.message ? e.message : String(e);
      }

      // 2. reqGameFriendsFromServer (GetGameFriends) 刷新真实植物状态
      if (opts.refreshPlantStatus !== false) {
        try {
          plantRefreshResult = await refreshFriendPlantStatus(ctx.manager, opts.plantRefreshTimeoutMs);
        } catch (e) {
          plantRefreshResult = { refreshed: false, error: e && e.message ? e.message : String(e) };
        }
      }
    // }

    const result = buildFriendEntriesResult(ctx.runtime, ctx.manager, opts, {
      requestedRefresh,
      refreshed,
      refreshError,
      refreshMode
    });
    result.plantRefresh = plantRefreshResult;
    return result;
  }

  function resolveFriendEntry(entries, target, opts) {
    opts = opts || {};
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) throw new Error('Friend list is empty');

    let gid = null;
    let query = '';
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      gid = toPositiveNumber(target.gid);
      query = normalizeText(
        target.name != null ? target.name
          : target.remark != null ? target.remark
          : target.displayName != null ? target.displayName
          : target.keyword != null ? target.keyword
          : target.query
      );
    } else if (typeof target === 'number') {
      gid = toPositiveNumber(target);
    } else {
      const text = normalizeText(target);
      if (/^\d+$/.test(text)) gid = toPositiveNumber(text);
      else query = text;
    }

    if (gid != null) {
      const byGid = list.find(entry => entry.item && entry.item.gid === gid);
      if (byGid) {
        return {
          entry: byGid,
          matchType: 'gid'
        };
      }
      if (!query) throw new Error('Friend not found by gid: ' + gid);
    }

    const normalized = normalizeMatchText(query);
    if (!normalized) throw new Error('target required');

    function exactMatches(getter) {
      return list.filter(entry => {
        const value = normalizeMatchText(getter(entry.item));
        return !!value && value === normalized;
      });
    }

    const strategies = [
      { matchType: 'remark_exact', matches: exactMatches(item => item.remark) },
      { matchType: 'displayName_exact', matches: exactMatches(item => item.displayName) },
      { matchType: 'name_exact', matches: exactMatches(item => item.name) }
    ];

    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      if (strategy.matches.length === 1) {
        return {
          entry: strategy.matches[0],
          matchType: strategy.matchType
        };
      }
      if (strategy.matches.length > 1) {
        throw new Error('Multiple friends matched ' + strategy.matchType + ': ' + formatFriendMatchList(strategy.matches));
      }
    }

    if (opts.fuzzy === false) {
      throw new Error('Friend not found: ' + query);
    }

    const fuzzyMatches = list.filter(entry => {
      const fields = getFriendSearchFields(entry.item);
      for (let i = 0; i < fields.length; i++) {
        if (normalizeMatchText(fields[i]).indexOf(normalized) >= 0) return true;
      }
      return false;
    });

    if (fuzzyMatches.length === 1) {
      return {
        entry: fuzzyMatches[0],
        matchType: 'fuzzy'
      };
    }
    if (fuzzyMatches.length > 1) {
      throw new Error('Multiple friends matched fuzzy query: ' + formatFriendMatchList(fuzzyMatches));
    }

    throw new Error('Friend not found: ' + query);
  }

  function buildFriendListPayload(data) {
    const list = data.entries.map(entry => entry.item);
    const counts = {
      friends: list.length,
      collectableFriends: 0,
      waterableFriends: 0,
      eraseGrassFriends: 0,
      killBugFriends: 0
    };
    const workCounts = {
      collect: 0,
      water: 0,
      eraseGrass: 0,
      killBug: 0
    };

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const work = item.workCounts || {};
      workCounts.collect += Number(work.collect) || 0;
      workCounts.water += Number(work.water) || 0;
      workCounts.eraseGrass += Number(work.eraseGrass) || 0;
      workCounts.killBug += Number(work.killBug) || 0;
      if (work.collect > 0) counts.collectableFriends++;
      if (work.water > 0) counts.waterableFriends++;
      if (work.eraseGrass > 0) counts.eraseGrassFriends++;
      if (work.killBug > 0) counts.killBugFriends++;
    }

    const payload = {
      source: data.source,
      requestedRefresh: data.requestedRefresh,
      refreshed: data.refreshed,
      refreshError: data.refreshError,
      refreshMode: data.refreshMode,
      reqFriendListed: data.reqFriendListed,
      selfGid: data.selfGid,
      count: list.length,
      counts,
      workCounts,
      list
    };
    return payload;
  }

  function getFriendList(opts) {
    opts = opts || {};
    if (opts.waitRefresh === true) {
      return (async () => {
        const data = await getFriendEntries(opts);
        const payload = buildFriendListPayload(data);
        return opts.silent ? payload : out(payload);
      })();
    }

    const data = getFriendEntriesSync(opts);
    const payload = buildFriendListPayload(data);

    return opts.silent ? payload : out(payload);
  }

  function findBackHomeButtonPath(ownership) {
    const evidence = ownership && ownership.evidence ? ownership.evidence : null;
    if (!evidence) return null;

    if (evidence.backHomeButton && evidence.backHomeButton.active && evidence.backHomeButton.path) {
      return evidence.backHomeButton.path;
    }

    const list = evidence.activeBackHomeButtons && Array.isArray(evidence.activeBackHomeButtons.list)
      ? evidence.activeBackHomeButtons.list
      : [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item && item.active && item.path) return item.path;
    }

    return null;
  }

  async function enterFriendFarm(target, opts) {
    if (target && typeof target === 'object' && !Array.isArray(target) && opts == null) {
      opts = target;
      target = opts.target != null
        ? opts.target
        : opts.gid != null
          ? opts.gid
          : opts.name != null
            ? opts.name
            : opts.keyword;
    }
    opts = opts || {};

    const data = await getFriendEntries(opts);
    const resolved = resolveFriendEntry(data.entries, target, opts);
    const farmUtilRuntime = getFarmUtilRuntime();
    if (!farmUtilRuntime || !farmUtilRuntime.FarmUtil) throw new Error('FarmUtil not found');

    const reason = resolveFarmEnterReason(opts.reason == null ? 'FRIEND' : opts.reason);
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const beforeOwnership = opts.includeBeforeOwnership ? getFarmOwnership({ silent: true }) : null;

    await farmUtilRuntime.FarmUtil.enterFarm(resolved.entry.item.gid, reason.value);

    if (waitMs > 0) {
      await wait(waitMs);
    }

    let afterOwnership = null;
    if (opts.includeAfterOwnership || waitMs > 0) {
      try {
        afterOwnership = getFarmOwnership({ silent: true });
      } catch (_) {
        afterOwnership = null;
      }
    }

    const payload = {
      ok: true,
      source: farmUtilRuntime.source,
      reason,
      matchType: resolved.matchType,
      friend: resolved.entry.item,
      beforeOwnership,
      afterOwnership
    };

    return opts.silent ? payload : out(payload);
  }

  async function enterFarmByGid(gid, opts) {
    opts = opts || {};
    const targetGid = toPositiveNumber(gid);
    if (targetGid == null) throw new Error('gid required');

    const farmUtilRuntime = getFarmUtilRuntime();
    if (!farmUtilRuntime || !farmUtilRuntime.FarmUtil) throw new Error('FarmUtil not found');

    const reason = resolveFarmEnterReason(opts.reason == null ? 'UNKNOWN' : opts.reason);
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const beforeOwnership = opts.includeBeforeOwnership ? getFarmOwnership({ silent: true }) : null;

    await farmUtilRuntime.FarmUtil.enterFarm(targetGid, reason.value);

    if (waitMs > 0) {
      await wait(waitMs);
    }

    let afterOwnership = null;
    if (opts.includeAfterOwnership || waitMs > 0) {
      try {
        afterOwnership = getFarmOwnership({ silent: true });
      } catch (_) {
        afterOwnership = null;
      }
    }

    const payload = {
      ok: true,
      gid: targetGid,
      source: farmUtilRuntime.source,
      reason,
      beforeOwnership,
      afterOwnership
    };

    return opts.silent ? payload : out(payload);
  }

  async function enterOwnFarm(opts) {
    opts = opts || {};
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const reason = resolveFarmEnterReason(opts.reason == null ? 'UNKNOWN' : opts.reason);
    let ownership = null;
    try {
      ownership = getFarmOwnership({ silent: true, allowWeakUi: true });
    } catch (_) {
      ownership = null;
    }

    if (ownership && ownership.farmType === 'own') {
      const payload = {
        ok: true,
        source: 'already_own',
        reason,
        beforeOwnership: opts.includeBeforeOwnership ? ownership : null,
        afterOwnership: opts.includeAfterOwnership || waitMs > 0 ? ownership : null,
        selfGid: getSelfGid()
      };
      return opts.silent ? payload : out(payload);
    }

    const backHomePath = findBackHomeButtonPath(ownership);
    if (backHomePath) {
      smartClick(backHomePath);
      if (waitMs > 0) {
        await wait(waitMs);
      }

      let afterOwnership = null;
      if (opts.includeAfterOwnership || waitMs > 0) {
        try {
          afterOwnership = getFarmOwnership({ silent: true, allowWeakUi: true });
        } catch (_) {
          afterOwnership = null;
        }
      }

      if (!afterOwnership || afterOwnership.farmType === 'own') {
        const payload = {
          ok: true,
          source: 'back_home_button',
          path: backHomePath,
          reason,
          beforeOwnership: opts.includeBeforeOwnership ? ownership : null,
          afterOwnership,
          selfGid: getSelfGid()
        };
        return opts.silent ? payload : out(payload);
      }
    }

    const selfGid = await waitForSelfGid({
      timeoutMs: Math.max(waitMs, 1500),
      intervalMs: 100
    });
    if (selfGid == null) throw new Error('self gid not ready');

    const payload = await enterFarmByGid(selfGid, {
      ...opts,
      reason: reason.value,
      silent: true
    });
    payload.selfGid = selfGid;
    return opts.silent ? payload : out(payload);
  }

  function normalizeLandId(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeLandIds(list) {
    const arr = Array.isArray(list) ? list : [];
    const outArr = [];
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      const landId = normalizeLandId(arr[i]);
      if (landId == null || seen.has(landId)) continue;
      seen.add(landId);
      outArr.push(landId);
    }
    return outArr;
  }

  function buildLandIdSet(list) {
    const set = new Set();
    const arr = normalizeLandIds(list);
    for (let i = 0; i < arr.length; i++) set.add(arr[i]);
    return set;
  }

  function getLandRuntime(pathOrGridOrComp) {
    if (pathOrGridOrComp && typeof pathOrGridOrComp.canWater === 'function') {
      return pathOrGridOrComp;
    }

    let landId = null;
    if (pathOrGridOrComp && typeof pathOrGridOrComp.getLandId === 'function') {
      landId = pathOrGridOrComp.getLandId();
    } else {
      const node = toNode(pathOrGridOrComp);
      if (node) {
        const gridComp = findComponentByName(node, 'l7') || findBestComponentByScore(node, scoreGridComponent, 2);
        if (gridComp && typeof gridComp.getLandId === 'function') {
          landId = gridComp.getLandId();
        }
      }
    }

    landId = normalizeLandId(landId);
    if (landId == null) return null;

    const farmModel = getFarmModel();
    if (!farmModel || typeof farmModel.getLandById !== 'function') return null;
    try {
      return farmModel.getLandById(landId) || null;
    } catch (_) {
      return null;
    }
  }

  function collectActionableLandIdsByGrid(root, farmType) {
    const idsByType = {
      collect: [],
      water: [],
      eraseGrass: [],
      killBug: [],
      eraseDead: []
    };

    const nodes = walk(root).filter(node => /(?:^|\/)grid_\d+_\d+$/.test(fullPath(node)));
    for (let i = 0; i < nodes.length; i++) {
      let info;
      try {
        info = getGridState(nodes[i], { silent: true, farmType });
      } catch (_) {
        continue;
      }

      const landId = normalizeLandId(info.landId);
      if (landId == null) continue;

      if (info.canCollect) idsByType.collect.push(landId);
      if (info.canWater) idsByType.water.push(landId);
      if (info.canEraseGrass) idsByType.eraseGrass.push(landId);
      if (info.canKillBug) idsByType.killBug.push(landId);
      if (info.canEraseDead) idsByType.eraseDead.push(landId);
    }

    return {
      collect: normalizeLandIds(idsByType.collect),
      water: normalizeLandIds(idsByType.water),
      eraseGrass: normalizeLandIds(idsByType.eraseGrass),
      killBug: normalizeLandIds(idsByType.killBug),
      eraseDead: normalizeLandIds(idsByType.eraseDead)
    };
  }

  function getAllGridNodes(root) {
    return walk(root).filter(node => /(?:^|\/)grid_\d+_\d+$/.test(fullPath(node)));
  }

  function resolveFarmContext(root, opts) {
    opts = opts || {};
    const farmStatus = opts.farmStatus && typeof opts.farmStatus === 'object'
      ? opts.farmStatus
      : null;
    const farmOwnership = opts.includeFarmOwnership === false
      ? null
      : (
          opts.farmOwnership ||
          (farmStatus && farmStatus.farmOwnership) ||
          getFarmOwnership({ path: root, silent: true })
        );
    const farmType = opts.farmType == null
      ? (
          farmStatus && farmStatus.farmType != null
            ? String(farmStatus.farmType)
            : farmOwnership
              ? farmOwnership.farmType
              : null
        )
      : String(opts.farmType);

    return {
      farmStatus,
      farmOwnership,
      farmType
    };
  }

  function getFarmWorkSummary(opts) {
    opts = opts || {};
    const root = findGridOrigin(opts.root || opts.path);
    if (!root) throw new Error('GridOrigin not found');

    const context = resolveFarmContext(root, opts);
    const farmOwnership = context.farmOwnership;
    const farmType = context.farmType;

    let idsByType = null;
    let source = 'grid_scan';
    let manager = null;
    try {
      manager = findOneClickManager(opts.path || root);
    } catch (_) {
      manager = null;
    }

    if (manager) {
      source = 'one_click_manager';
      idsByType = {
        collect: typeof manager.getAllHarvestableLandIds === 'function'
          ? normalizeLandIds(manager.getAllHarvestableLandIds())
          : [],
        water: typeof manager.getAllWaterableLandIds === 'function'
          ? normalizeLandIds(manager.getAllWaterableLandIds())
          : [],
        eraseGrass: typeof manager.getAllEraseGrassLandIds === 'function'
          ? normalizeLandIds(manager.getAllEraseGrassLandIds())
          : [],
        killBug: typeof manager.getAllKillBugLandIds === 'function'
          ? normalizeLandIds(manager.getAllKillBugLandIds())
          : [],
        eraseDead: typeof manager.getAllEraseableLandIds === 'function'
          ? normalizeLandIds(manager.getAllEraseableLandIds())
          : []
      };
    } else {
      idsByType = collectActionableLandIdsByGrid(root, farmType);
    }

    const payload = {
      farmOwnership,
      farmType,
      source,
      managerNodePath: manager && manager.node ? fullPath(manager.node) : null,
      counts: {
        collect: idsByType.collect.length,
        water: idsByType.water.length,
        eraseGrass: idsByType.eraseGrass.length,
        killBug: idsByType.killBug.length,
        eraseDead: idsByType.eraseDead.length
      },
      landIds: idsByType,
      sets: {
        collect: buildLandIdSet(idsByType.collect),
        water: buildLandIdSet(idsByType.water),
        eraseGrass: buildLandIdSet(idsByType.eraseGrass),
        killBug: buildLandIdSet(idsByType.killBug),
        eraseDead: buildLandIdSet(idsByType.eraseDead)
      }
    };

    if (opts.silent) return payload;

    return out({
      farmOwnership: payload.farmOwnership,
      farmType: payload.farmType,
      source: payload.source,
      managerNodePath: payload.managerNodePath,
      counts: payload.counts,
      landIds: payload.landIds
    });
  }

  function getGridComponent(pathOrNode) {
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Grid node not found: ' + pathOrNode);

    const comp = findComponentByName(node, 'l7') || findBestComponentByScore(node, scoreGridComponent, 2);
    if (!comp) throw new Error('Grid controller not found: ' + fullPath(node));
    return comp;
  }

  function getPlantComponent(pathOrNode) {
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Plant node not found: ' + pathOrNode);

    const comp = findComponentByName(node, 'ln') || findBestComponentByScore(node, scorePlantComponent, 2);
    if (!comp) throw new Error('Plant controller not found: ' + fullPath(node));
    return comp;
  }

  function getGridKey(input) {
    if (!input) return null;

    if (typeof input === 'string') {
      const match = /(?:plant_)?grid_(\d+)_(\d+)$/.exec(input);
      return match ? match[1] + '_' + match[2] : null;
    }

    if (typeof input.gridX === 'number' && typeof input.gridY === 'number') {
      return input.gridX + '_' + input.gridY;
    }

    if (input.node) return getGridKey(fullPath(input.node));
    return null;
  }

  function getGridCoords(input) {
    const key = getGridKey(input);
    if (!key) return null;
    const parts = key.split('_');
    return {
      x: Number(parts[0]),
      y: Number(parts[1])
    };
  }

  function getPlantNodeByGrid(pathOrNode) {
    const plantOrigin = findPlantOrigin();
    if (!plantOrigin) return null;

    const key = getGridKey(pathOrNode);
    if (!key) return null;

    return findNode(fullPath(plantOrigin) + '/plant_grid_' + key);
  }

  function getGridNodeByPlant(pathOrNode) {
    const gridOrigin = findGridOrigin();
    if (!gridOrigin) return null;

    const key = getGridKey(pathOrNode);
    if (!key) return null;

    return findNode(fullPath(gridOrigin) + '/grid_' + key);
  }

  function parseGrowPhases(growPhases) {
    return String(growPhases || '')
      .split(';')
      .map(item => item.trim())
      .filter(Boolean)
      .map((item, index) => {
        const parts = item.split(':');
        return {
          index: index + 1,
          name: parts[0] || '',
          duration: parts[1] == null ? null : Number(parts[1])
        };
      });
  }

  function getPlantRuntime(pathOrGridOrComp) {
    let plant;

    if (pathOrGridOrComp && typeof pathOrGridOrComp.checkHasPlant === 'function') {
      plant = pathOrGridOrComp.checkHasPlant();
    } else if (pathOrGridOrComp && typeof pathOrGridOrComp.getPlantData === 'function') {
      plant = pathOrGridOrComp.getPlantData();
    } else {
      const node = toNode(pathOrGridOrComp);
      if (!node) return null;

      const gridComp = findComponentByName(node, 'l7') || findBestComponentByScore(node, scoreGridComponent, 2);
      if (gridComp && typeof gridComp.checkHasPlant === 'function') {
        plant = gridComp.checkHasPlant();
      } else {
        const plantComp = findComponentByName(node, 'ln') || findBestComponentByScore(node, scorePlantComponent, 2);
        if (plantComp) {
          plant = typeof plantComp.getPlantData === 'function'
            ? plantComp.getPlantData()
            : plantComp.plantData;
        }
      }
    }

    return plant || null;
  }

  /** 与 game.resolved.js 中 PlantStage 枚举一致：MATURE=6, DEAD=7, ERASED=8 */
  const PlantStage = {
    PHASE_UNKNOWN: 0,
    SEED: 1,
    GERMINATION: 2,
    SMALL_LEAVES: 3,
    LARGE_LEAVES: 4,
    BLOOMING: 5,
    MATURE: 6,
    DEAD: 7,
    ERASED: 8
  };

  function getPlantStageSummary(plantRuntime) {
    if (!plantRuntime) return null;

    const config = plantRuntime.config || {};
    const plantData = plantRuntime.plantData || {};
    const phases = parseGrowPhases(config.grow_phases);
    const totalStages = phases.length > 0
      ? phases.length
      : Array.isArray(plantData.stage_infos) && plantData.stage_infos.length > 0
        ? Math.max.apply(null, plantData.stage_infos.map(x => Number(x.stage) || 0))
        : null;
    const currentStage = plantData.current_stage == null ? null : Number(plantData.current_stage);

    const isMatureByEnum = typeof plantRuntime.isMature === 'function'
      ? !!plantRuntime.isMature()
      : currentStage === PlantStage.MATURE;
    const isDeadByEnum = typeof plantRuntime.isDead === 'function'
      ? !!plantRuntime.isDead()
      : currentStage === PlantStage.DEAD;
    const isMatureByPhases = totalStages != null && currentStage === totalStages;

    return {
      config,
      plantData,
      phases,
      totalStages,
      currentStage,
      isMature: isMatureByEnum || isMatureByPhases,
      isDead: isDeadByEnum,
      isMatureByEnum,
      isMatureByPhases
    };
  }

  function getLandStageKind(hasPlant, stage) {
    if (!hasPlant) return 'empty';
    if (!stage) return 'unknown';
    if (stage.isDead) return 'dead';
    if (stage.currentStage === PlantStage.ERASED || stage.currentStage === PlantStage.PHASE_UNKNOWN) {
      return 'empty';
    }
    if (stage.isMature) return 'mature';
    if (typeof stage.currentStage === 'number' && stage.currentStage >= PlantStage.SEED && stage.currentStage < PlantStage.MATURE) {
      return 'growing';
    }
    return 'other';
  }

  function toTimestampMs(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num > 1e12 ? num : num * 1000;
  }

  function getLandTypeByLevel(level) {
    const lv = Number(level);
    if (!Number.isFinite(lv)) return null;
    if (lv >= 4) return 'gold';
    if (lv === 3) return 'black';
    if (lv === 2) return 'red';
    return 'normal';
  }

  function detectLandTypeFromTexts(texts) {
    const list = Array.isArray(texts) ? texts : [];
    for (let i = 0; i < list.length; i += 1) {
      const text = String(list[i] || '').trim();
      if (!text) continue;
      if (text.indexOf('金土地') >= 0) return 'gold';
      if (text.indexOf('黑土地') >= 0) return 'black';
      if (text.indexOf('红土地') >= 0) return 'red';
      if (text.indexOf('普通土地') >= 0) return 'normal';
    }
    return null;
  }

  function pickLandTypeFromRuntime(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const candidates = [
      safeReadKey(obj, 'landType'),
      safeReadKey(obj, 'land_type'),
      safeReadKey(obj, 'soilType'),
      safeReadKey(obj, 'soil_type'),
      safeReadKey(obj, 'terrainType'),
      safeReadKey(obj, 'terrain_type'),
      safeReadKey(obj, 'quality'),
      safeReadKey(obj, 'landQuality')
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const value = candidates[i];
      if (value == null || value === '') continue;
      const text = String(value).trim().toLowerCase();
      if (text === 'gold' || text === '金土地' || text === '4') return 'gold';
      if (text === 'black' || text === '黑土地' || text === '3') return 'black';
      if (text === 'red' || text === '红土地' || text === '2') return 'red';
      if (text === 'normal' || text === '普通土地' || text === '0') return 'normal';
    }
    return null;
  }

  function getLandBonusProfile(source) {
    if (!source || typeof source !== 'object') return null;
    const yieldBonus = Number(safeCall(function () {
      return typeof source.getPlantYieldBonus === 'function' ? source.getPlantYieldBonus() : null;
    }, null));
    const plantingTimeReduction = Number(safeCall(function () {
      return typeof source.getPlantingTimeReduction === 'function' ? source.getPlantingTimeReduction() : null;
    }, null));
    const expBonus = Number(safeCall(function () {
      return typeof source.getPlantExpBonus === 'function' ? source.getPlantExpBonus() : null;
    }, null));
    const hasAny = [yieldBonus, plantingTimeReduction, expBonus].some(function (value) {
      return Number.isFinite(value);
    });
    if (!hasAny) return null;
    return {
      yieldBonus: Number.isFinite(yieldBonus) ? yieldBonus : null,
      plantingTimeReduction: Number.isFinite(plantingTimeReduction) ? plantingTimeReduction : null,
      expBonus: Number.isFinite(expBonus) ? expBonus : null,
    };
  }

  function getLandTypeByBonusProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const yieldBonus = Number(profile.yieldBonus);
    const plantingTimeReduction = Number(profile.plantingTimeReduction);
    const expBonus = Number(profile.expBonus);
    if (
      (Number.isFinite(yieldBonus) && yieldBonus >= 30000) ||
      (Number.isFinite(plantingTimeReduction) && plantingTimeReduction >= 2000) ||
      (Number.isFinite(expBonus) && expBonus >= 2000)
    ) {
      return 'gold';
    }
    if (
      (Number.isFinite(yieldBonus) && yieldBonus >= 20000) ||
      (Number.isFinite(plantingTimeReduction) && plantingTimeReduction >= 1000)
    ) {
      return 'black';
    }
    if (
      (Number.isFinite(yieldBonus) && yieldBonus >= 10000) ||
      (Number.isFinite(plantingTimeReduction) && plantingTimeReduction > 0) ||
      (Number.isFinite(expBonus) && expBonus > 0)
    ) {
      return 'red';
    }
    if (
      Number.isFinite(yieldBonus) ||
      Number.isFinite(plantingTimeReduction) ||
      Number.isFinite(expBonus)
    ) {
      return 'normal';
    }
    return null;
  }

  function collectNodeTexts(node, maxDepth, limit) {
    if (!node) return [];
    const list = getNodeTextList(node, { maxDepth: maxDepth == null ? 4 : maxDepth });
    return Array.isArray(list) ? list.slice(0, limit == null ? 40 : limit) : [];
  }

  function getPhaseNameByStage(stageSummary) {
    if (!stageSummary) return null;
    const currentStage = Number(stageSummary.currentStage);
    if (!Number.isFinite(currentStage) || currentStage <= 0) return null;
    const phases = Array.isArray(stageSummary.phases) ? stageSummary.phases : [];
    const hit = phases.find(function (item) { return Number(item && item.index) === currentStage; });
    return hit && hit.name ? String(hit.name) : null;
  }

  function getMatureTimingSummary(stageSummary) {
    if (!stageSummary || !stageSummary.plantData) {
      return {
        matureAtMs: null,
        matureInSec: null,
        currentSeason: 0,
        totalSeason: 0,
        phaseName: null
      };
    }

    const plantData = stageSummary.plantData || {};
    const stageInfos = Array.isArray(plantData.stage_infos) ? plantData.stage_infos : [];
    const totalSeason = Math.max(1, Number(stageSummary.config && stageSummary.config.seasons) || 1);
    const currentSeasonRaw = Number(safeReadKey(plantData, 'season'));
    const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
    const currentStage = Number(stageSummary.currentStage);
    const totalStages = Number(stageSummary.totalStages);

    let matureInfo = null;
    for (let i = 0; i < stageInfos.length; i += 1) {
      const info = stageInfos[i];
      const stage = Number(info && info.stage);
      if (stage === PlantStage.MATURE || (Number.isFinite(totalStages) && totalStages > 0 && stage === totalStages)) {
        matureInfo = info;
        break;
      }
    }

    const matureAtMs = matureInfo
      ? (
          toTimestampMs(safeReadKey(matureInfo, 'begin_time')) ||
          toTimestampMs(safeReadKey(matureInfo, 'beginTime')) ||
          toTimestampMs(safeReadKey(matureInfo, 'start_time')) ||
          toTimestampMs(safeReadKey(matureInfo, 'startTime'))
        )
      : null;
    const nowMs = Date.now();
    const matureInSec = stageSummary.isMature
      ? 0
      : matureAtMs && matureAtMs > nowMs
        ? Math.max(0, Math.ceil((matureAtMs - nowMs) / 1000))
        : null;

    return {
      matureAtMs,
      matureInSec,
      currentSeason,
      totalSeason,
      phaseName: getPhaseNameByStage(stageSummary),
      currentStage: Number.isFinite(currentStage) ? currentStage : null
    };
  }

  function getGridState(pathOrNode, opts) {
    opts = opts || {};
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Grid node not found: ' + pathOrNode);

    const gridComp = getGridComponent(node);
    const plantRuntime = getPlantRuntime(gridComp);
    const landId = typeof gridComp.getLandId === 'function' ? normalizeLandId(gridComp.getLandId()) : null;
    const landRuntime = getLandRuntime(gridComp);
    const landData = typeof gridComp.getLandData === 'function'
      ? safeCall(function () { return gridComp.getLandData(); }, null)
      : null;
    const landCellData = safeReadKey(gridComp, 'landCellData');
    const stage = getPlantStageSummary(plantRuntime);
    const timing = getMatureTimingSummary(stage);
    const plantNode = getPlantNodeByGrid(node);
    const hasPlant = !!plantRuntime;
    const landLevelRaw =
      safeReadKey(landRuntime, 'level') != null ? safeReadKey(landRuntime, 'level') :
      (safeReadKey(landRuntime, 'lands_level') != null ? safeReadKey(landRuntime, 'lands_level') :
      (safeReadKey(landRuntime, 'landsLevel') != null ? safeReadKey(landRuntime, 'landsLevel') : safeReadKey(landRuntime, 'land_level')));
    const landLevelNum = landLevelRaw == null || landLevelRaw === ''
      ? null
      : Number(landLevelRaw);
    const landLevelValue = Number.isFinite(landLevelNum) ? landLevelNum : null;
    const actionSets = opts.actionSets || null;
    const canHarvestRuntime = hasPlant && typeof plantRuntime.canHarvest === 'function'
      ? !!plantRuntime.canHarvest()
      : !!stage && !!stage.isMature;
    const canStealRuntime = hasPlant && typeof plantRuntime.canSteal === 'function'
      ? !!plantRuntime.canSteal()
      : false;
    const canWaterRuntime = actionSets && actionSets.water && landId != null
      ? actionSets.water.has(landId)
      : landRuntime && typeof landRuntime.canWater === 'function'
        ? !!landRuntime.canWater()
        : stage && stage.plantData && stage.plantData.dry_num != null
          ? Number(stage.plantData.dry_num) > 0
          : false;
    const canEraseGrassRuntime = actionSets && actionSets.eraseGrass && landId != null
      ? actionSets.eraseGrass.has(landId)
      : hasPlant && typeof plantRuntime.canEraseGrass === 'function'
        ? !!plantRuntime.canEraseGrass()
        : stage && stage.plantData && stage.plantData.weeds_num != null
          ? Number(stage.plantData.weeds_num) > 0
          : false;
    const canKillBugRuntime = actionSets && actionSets.killBug && landId != null
      ? actionSets.killBug.has(landId)
      : hasPlant && typeof plantRuntime.canKillBug === 'function'
        ? !!plantRuntime.canKillBug()
        : stage && stage.plantData && stage.plantData.insects_num != null
          ? Number(stage.plantData.insects_num) > 0
          : false;
    const farmType = opts.farmType == null ? null : String(opts.farmType);
    const canCollectRuntime = farmType === 'friend'
      ? canStealRuntime
      : farmType === 'own'
        ? canHarvestRuntime
        : (canHarvestRuntime || canStealRuntime);
    const canEraseDeadRuntime = actionSets && actionSets.eraseDead && landId != null
      ? actionSets.eraseDead.has(landId)
      : stage
        ? !!stage.isDead
        : hasPlant && typeof plantRuntime.isDead === 'function'
          ? !!plantRuntime.isDead()
          : false;

    const landBonusSource = landData || landCellData || null;
    const landBonusProfile = getLandBonusProfile(landBonusSource);
    const payload = {
      path: fullPath(node),
      gridPos: typeof gridComp.getGridPosition === 'function' ? gridComp.getGridPosition() : getGridCoords(node),
      landId,
      interactable: typeof gridComp.getInteractable === 'function' ? !!gridComp.getInteractable() : !!gridComp.isInteractable,
      selected: typeof gridComp.getSelected === 'function' ? !!gridComp.getSelected() : !!gridComp.isSelected,
      hasPlant,
      stageKind: getLandStageKind(hasPlant, stage),
      plantNode: plantNode ? fullPath(plantNode) : null,
      plantName: stage && stage.config ? stage.config.name || null : null,
      plantId: stage && stage.plantData ? stage.plantData.id : null,
      phaseName: timing.phaseName || null,
      currentStage: stage ? stage.currentStage : null,
      totalStages: stage ? stage.totalStages : null,
      currentSeason: timing.currentSeason,
      totalSeason: timing.totalSeason,
      matureAtMs: timing.matureAtMs,
      matureInSec: timing.matureInSec,
      isMature: stage ? !!stage.isMature : false,
      isDead: stage ? !!stage.isDead : false,
      canHarvest: canHarvestRuntime,
      canSteal: canStealRuntime,
      canCollect: canCollectRuntime,
      canWater: canWaterRuntime,
      canEraseGrass: canEraseGrassRuntime,
      canKillBug: canKillBugRuntime,
      canEraseDead: canEraseDeadRuntime,
      needsWater: canWaterRuntime,
      needsEraseGrass: canEraseGrassRuntime,
      needsKillBug: canKillBugRuntime,
      needsEraseDead: canEraseDeadRuntime,
      landLevel: landLevelValue,
      landType:
        pickLandTypeFromRuntime(landData) ||
        pickLandTypeFromRuntime(landCellData) ||
        getLandTypeByBonusProfile(landBonusProfile) ||
        getLandTypeByLevel(landLevelValue),
      landBonusProfile: landBonusProfile,
      couldUpgrade: !!safeReadKey(landRuntime, 'could_upgrade'),
      couldUnlock: !!safeReadKey(landRuntime, 'could_unlock'),
      landSize: Number(safeReadKey(landRuntime, 'land_size')) || 1,
      leftFruit: stage && stage.plantData ? stage.plantData.left_fruit_num : null,
      fruitNum: stage && stage.plantData ? stage.plantData.fruit_num : null,
      raw: plantRuntime
    };
    if (opts.includeRawLandRuntime) {
      payload.rawLandRuntime = summarizeRuntimeObject(landRuntime, 'landRuntime');
      payload.rawLandData = summarizeRuntimeObject(landData, 'landData');
      payload.rawLandCellData = summarizeRuntimeObject(landCellData, 'landCellData');
    }
    return opts.silent ? payload : out(payload);
  }

  function getFarmStatus(opts) {
    opts = opts || {};
    const root = findGridOrigin(opts.root || opts.path);
    if (!root) throw new Error('GridOrigin not found');

    const context = resolveFarmContext(root, opts);
    const farmOwnership = context.farmOwnership;
    const farmType = context.farmType;
    const workSummary = getFarmWorkSummary({ path: root, farmOwnership, farmType, silent: true });
    const actionSets = workSummary.sets;
    const includeGrids = opts.includeGrids !== false;
    const includeLandIds = opts.includeLandIds !== false;
    const includeRawGrid = !!opts.includeRawGrid;
    const nodes = getAllGridNodes(root);
    const stageCounts = {
      empty: 0,
      mature: 0,
      dead: 0,
      growing: 0,
      other: 0,
      unknown: 0,
      error: 0
    };
    const grids = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      try {
        const s = getGridState(node, {
          silent: true,
          farmType,
          actionSets,
          includeRawLandRuntime: !!opts.includeRawLandRuntime,
        });
        const kind = s.stageKind || 'unknown';
        if (stageCounts.hasOwnProperty(kind)) stageCounts[kind]++;
        else stageCounts.other++;

        if (includeGrids) {
          const entry = {
            path: s.path,
            gridPos: s.gridPos,
            landId: s.landId,
            interactable: s.interactable,
            selected: s.selected,
            hasPlant: s.hasPlant,
            stageKind: s.stageKind,
            plantNode: s.plantNode,
            plantName: s.plantName,
            plantId: s.plantId,
            phaseName: s.phaseName,
            currentStage: s.currentStage,
            totalStages: s.totalStages,
            currentSeason: s.currentSeason,
            totalSeason: s.totalSeason,
            matureAtMs: s.matureAtMs,
            matureInSec: s.matureInSec,
            isMature: s.isMature,
            isDead: s.isDead,
            canHarvest: s.canHarvest,
            canSteal: s.canSteal,
            canCollect: s.canCollect,
            canWater: s.canWater,
            canEraseGrass: s.canEraseGrass,
            canKillBug: s.canKillBug,
            canEraseDead: s.canEraseDead,
            needsWater: s.needsWater,
            needsEraseGrass: s.needsEraseGrass,
            needsKillBug: s.needsKillBug,
            needsEraseDead: s.needsEraseDead,
            landLevel: s.landLevel,
            landType: s.landType,
            couldUpgrade: s.couldUpgrade,
            couldUnlock: s.couldUnlock,
            landSize: s.landSize,
            leftFruit: s.leftFruit,
            fruitNum: s.fruitNum
          };
          if (includeRawGrid) entry.raw = s.raw;
          if (opts.includeRawLandRuntime && s.rawLandRuntime) entry.rawLandRuntime = s.rawLandRuntime;
          if (opts.includeRawLandRuntime && s.rawLandData) entry.rawLandData = s.rawLandData;
          if (opts.includeRawLandRuntime && s.rawLandCellData) entry.rawLandCellData = s.rawLandCellData;
          if (s.landBonusProfile) entry.landBonusProfile = s.landBonusProfile;
          grids.push(entry);
        }
      } catch (e) {
        stageCounts.error++;
        if (includeGrids) {
          grids.push({
            path: fullPath(node),
            error: e && e.message ? e.message : String(e)
          });
        }
      }
    }

    const payload = {
      farmOwnership,
      farmType,
      totalGrids: nodes.length,
      stageCounts,
      workCounts: workSummary.counts,
      workSource: workSummary.source,
      managerNodePath: workSummary.managerNodePath
    };

    if (includeLandIds) payload.landIds = workSummary.landIds;
    if (includeGrids) payload.grids = grids;

    return opts.silent ? payload : out(payload);
  }

  function summarizeAllGrids(opts) {
    opts = opts || {};
    const status = getFarmStatus({
      ...opts,
      includeGrids: !!opts.includePaths,
      includeLandIds: false,
      silent: true
    });
    const payload = {
      farmOwnership: status.farmOwnership,
      farmType: status.farmType,
      workCounts: status.workCounts,
      totalGrids: status.totalGrids,
      counts: status.stageCounts,
      details: opts.includePaths ? status.grids : undefined
    };
    return opts.silent ? payload : out(payload);
  }

  function findHarvestableGrids(opts) {
    opts = opts || {};
    const root = findGridOrigin(opts.root || opts.path);
    if (!root) throw new Error('GridOrigin not found');
    const context = resolveFarmContext(root, opts);
    const farmOwnership = context.farmOwnership;
    const farmType = context.farmType;
    const workSummary = getFarmWorkSummary({ path: root, farmOwnership, farmType, silent: true });
    const actionMode = String(
      opts.actionMode || (farmType === 'friend' ? 'steal' : farmType === 'own' ? 'harvest' : 'collect')
    ).toLowerCase();

    const matureOnly = opts.matureOnly !== false;
    const nodes = getAllGridNodes(root);
    const list = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let info;
      try {
        info = getGridState(node, { silent: true, farmType, actionSets: workSummary.sets });
      } catch (_) {
        continue;
      }
      if (!info.hasPlant) continue;
      if (matureOnly && !info.isMature) continue;
      if (actionMode === 'harvest' && !info.canHarvest) continue;
      if (actionMode === 'steal' && !info.canSteal) continue;
      if (actionMode !== 'harvest' && actionMode !== 'steal' && !info.canCollect) continue;
      list.push({
        path: info.path,
        gridPos: info.gridPos,
        landId: info.landId,
        plantNode: info.plantNode,
        plantName: info.plantName,
        plantId: info.plantId,
        currentStage: info.currentStage,
        totalStages: info.totalStages,
        isMature: info.isMature,
        canHarvest: info.canHarvest,
        canSteal: info.canSteal,
        canCollect: info.canCollect,
        leftFruit: info.leftFruit,
        fruitNum: info.fruitNum
      });
    }

    return out({
      farmOwnership,
      farmType,
      actionMode,
      matureOnly,
      count: list.length,
      list
    });
  }

  function findMatureGrids(opts) {
    opts = opts || {};
    return findHarvestableGrids({ ...opts, matureOnly: true });
  }

  function normalizeGridActionType(action) {
    const raw = String(action == null ? 'collect' : action).trim().toLowerCase();
    const aliases = {
      collect: 'collect',
      harvest: 'collect',
      steal: 'collect',
      water: 'water',
      watering: 'water',
      bug: 'killBug',
      insect: 'killBug',
      killbug: 'killBug',
      kill_bug: 'killBug',
      grass: 'eraseGrass',
      weed: 'eraseGrass',
      erasegrass: 'eraseGrass',
      erase_grass: 'eraseGrass',
      dead: 'eraseDead',
      withered: 'eraseDead',
      erase_dead: 'eraseDead',
      erasedead: 'eraseDead'
    };
    if (aliases.hasOwnProperty(raw)) return aliases[raw];
    throw new Error('Unknown grid action type: ' + action);
  }

  function findActionableGrids(action, opts) {
    opts = opts || {};
    const root = findGridOrigin(opts.root || opts.path);
    if (!root) throw new Error('GridOrigin not found');

    const context = resolveFarmContext(root, opts);
    const farmOwnership = context.farmOwnership;
    const farmType = context.farmType;
    const actionType = normalizeGridActionType(action || opts.action);
    const workSummary = getFarmWorkSummary({ path: root, farmOwnership, farmType, silent: true });
    const landSet = workSummary.sets[actionType];
    const nodes = getAllGridNodes(root);
    const list = [];

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let info;
      try {
        info = getGridState(node, { silent: true, farmType, actionSets: workSummary.sets });
      } catch (_) {
        continue;
      }

      const landId = normalizeLandId(info.landId);
      if (landId == null || !landSet || !landSet.has(landId)) continue;

      list.push({
        path: info.path,
        gridPos: info.gridPos,
        landId: info.landId,
        plantNode: info.plantNode,
        plantName: info.plantName,
        plantId: info.plantId,
        currentStage: info.currentStage,
        totalStages: info.totalStages,
        stageKind: info.stageKind,
        isMature: info.isMature,
        isDead: info.isDead,
        canHarvest: info.canHarvest,
        canSteal: info.canSteal,
        canCollect: info.canCollect,
        canWater: info.canWater,
        canEraseGrass: info.canEraseGrass,
        canKillBug: info.canKillBug,
        canEraseDead: info.canEraseDead,
        leftFruit: info.leftFruit,
        fruitNum: info.fruitNum
      });
    }

    return out({
      farmOwnership,
      farmType,
      action: actionType,
      count: list.length,
      list
    });
  }

  function findWaterableGrids(opts) {
    return findActionableGrids('water', opts);
  }

  function findEraseGrassGrids(opts) {
    return findActionableGrids('eraseGrass', opts);
  }

  function findKillBugGrids(opts) {
    return findActionableGrids('killBug', opts);
  }

  function findDeadGrids(opts) {
    return findActionableGrids('eraseDead', opts);
  }

  function inspectOneClickToolNodes(pathOrNode) {
    const parent = toNode(pathOrNode) || findNode('startup/root/ui/LayerUI/main_ui_v2/foot/LoadLazyRoot/OneClickOperationTools/parentNode') || findNode('root/ui/LayerUI/main_ui_v2/foot/LoadLazyRoot/OneClickOperationTools/parentNode');
    if (!parent) throw new Error('OneClickOperationTools parentNode not found');

    return out((parent.children || []).map(node => {
      const comp = findComponentByName(node, 'l4');
      const btn = node.getComponent ? node.getComponent(cc.Button) : null;
      return {
        path: fullPath(node),
        name: node.name,
        active: !!node.activeInHierarchy,
        components: componentNames(node),
        effectId: comp ? comp.effectId : null,
        interval: comp ? comp.interval : null,
        once: comp ? comp.once : null,
        clickEventCount: btn && btn.clickEvents ? btn.clickEvents.length : 0
      };
    }));
  }

  function isOneClickManagerComponent(comp) {
    if (!comp) return false;
    return typeof comp.onButtonClick === 'function'
      && typeof comp.getAllHarvestableLandIds === 'function'
      && typeof comp.updateAllButtonsVisibility === 'function';
  }

  function findOneClickManager(pathOrNode) {
    const directNode = toNode(pathOrNode);
    if (directNode) {
      const directComp = (directNode.components || []).find(isOneClickManagerComponent);
      if (directComp) return directComp;
    }

    const candidatePaths = [
      'startup/root/ui/LayerUI/main_ui_v2/foot/LoadLazyRoot/OneClickOperationTools',
      'root/ui/LayerUI/main_ui_v2/foot/LoadLazyRoot/OneClickOperationTools',
      'startup/root/ui/LayerUI/main_ui_v2/foot/LoadLazyRoot',
      'root/ui/LayerUI/main_ui_v2/foot/LoadLazyRoot'
    ];

    for (let i = 0; i < candidatePaths.length; i++) {
      const node = findNode(candidatePaths[i]);
      if (!node) continue;
      const comp = (node.components || []).find(isOneClickManagerComponent);
      if (comp) return comp;
      const nested = walk(node)
        .map(child => (child.components || []).find(isOneClickManagerComponent))
        .find(Boolean);
      if (nested) return nested;
    }

    return walk(scene())
      .map(node => (node.components || []).find(isOneClickManagerComponent))
      .find(Boolean) || null;
  }

  function getOneClickOperationNames() {
    return ['HARVEST', 'WATER', 'ERASE_GRASS', 'KILL_BUG'];
  }

  function resolveOneClickOperationIndex(typeOrIndex) {
    if (typeof typeOrIndex === 'number' && isFinite(typeOrIndex)) return typeOrIndex;
    const raw = String(typeOrIndex == null ? 'HARVEST' : typeOrIndex).trim().toUpperCase();
    const aliases = {
      'HARVEST': 0,
      'COLLECT': 0,
      'SHOUHUO': 0,
      'SHOU_HUO': 0,
      '收获': 0,
      '一键收获': 0,
      'WATER': 1,
      '浇水': 1,
      'ERASE_GRASS': 2,
      'GRASS': 2,
      '除草': 2,
      'KILL_BUG': 3,
      'BUG': 3,
      '除虫': 3
    };
    if (aliases.hasOwnProperty(raw)) return aliases[raw];
    throw new Error('Unknown one-click operation: ' + typeOrIndex);
  }

  function getOneClickManagerState(pathOrNode, opts) {
    opts = opts || {};
    const comp = findOneClickManager(pathOrNode);
    if (!comp) throw new Error('OneClickOperationBtnComp not found');

    const names = getOneClickOperationNames();
    const harvestButtonNode = comp.buttons && comp.buttons[0] && comp.buttons[0].node
      ? comp.buttons[0].node
      : null;
    const buttons = (comp.buttons || []).map((btn, index) => ({
      index,
      type: names[index] || String(index),
      path: btn && btn.node ? fullPath(btn.node) : null,
      active: !!(btn && btn.node && btn.node.activeInHierarchy),
      interactable: !!(btn && btn.interactable),
      hasHandler: !!(comp.buttonClickHandlers && comp.buttonClickHandlers.has && comp.buttonClickHandlers.has(index))
    }));

    const payload = {
      componentName: comp.constructor ? comp.constructor.name : String(comp),
      nodePath: comp.node ? fullPath(comp.node) : null,
      activeOperationType: comp.activeOperationType == null ? null : comp.activeOperationType,
      suppressHarvestButton: !!comp.suppressHarvestButton,
      cachedIsOwerFarm: typeof comp.cachedIsOwerFarm === 'boolean' ? !!comp.cachedIsOwerFarm : null,
      harvestButtonTexts: harvestButtonNode ? getNodeTextList(harvestButtonNode, { maxDepth: 3 }) : [],
      buttonVisibilityCache: comp.buttonVisibilityCache && comp.buttonVisibilityCache.forEach
        ? (() => {
            const arr = [];
            comp.buttonVisibilityCache.forEach(v => arr.push(v));
            return arr.sort();
          })()
        : [],
      buttons
    };
    return opts.silent ? payload : out(payload);
  }

  function triggerOneClickOperation(typeOrIndex, opts) {
    opts = opts || {};
    const comp = findOneClickManager(opts.path);
    if (!comp) throw new Error('OneClickOperationBtnComp not found');

    const index = resolveOneClickOperationIndex(typeOrIndex);
    if (typeof comp.onButtonClick !== 'function') {
      throw new Error('onButtonClick not found on OneClickOperationBtnComp');
    }

    const before = opts.includeBefore === false ? null : getOneClickManagerState(comp.node);
    const ret = comp.onButtonClick(index);
    const after = opts.includeAfter === false ? null : getOneClickManagerState(comp.node);

    const payload = {
      action: 'triggerOneClickOperation',
      index,
      type: getOneClickOperationNames()[index] || String(index),
      ret,
      before,
      after
    };
    return opts.silent ? payload : out(payload);
  }

  async function triggerOneClickOperationAndDismiss(typeOrIndex, opts) {
    const payload = triggerOneClickOperation(typeOrIndex, { ...(opts || {}), silent: true });
    const shouldDismiss = String(payload && payload.type || '').toLowerCase() === 'harvest';
    let rewardDismiss = null;
    if (shouldDismiss) {
      rewardDismiss = await dismissRewardPopup({
        silent: true,
        waitAfter: opts && opts.rewardWaitAfter == null ? 180 : opts && opts.rewardWaitAfter,
      });
    }
    const result = {
      ...payload,
      rewardDismiss,
    };
    return opts && opts.silent ? result : out(result);
  }

  function triggerOneClickHarvest(opts) {
    return triggerOneClickOperation(0, opts);
  }

  // ─── 种植相关 ───

  function getSystemExportRuntime(moduleIds, exportName) {
    const resolved = findSystemModuleExport(moduleIds, exportName);
    if (!resolved || resolved.value == null) return null;
    return {
      source: 'System:' + resolved.moduleId,
      moduleId: resolved.moduleId,
      exportName: exportName,
      value: resolved.value,
      namespace: resolved.namespace || null
    };
  }

  function getSingletonModuleComp() {
    const resolved = getSystemExportRuntime(
      ['chunks:///_virtual/SingletonModuleComp.ts', './SingletonModuleComp.ts'],
      'smc'
    );
    if (resolved && resolved.value && typeof resolved.value === 'object') {
      return resolved.value;
    }

    const directCandidates = [
      G.smc,
      G.GameGlobal && G.GameGlobal.smc
    ];
    for (let i = 0; i < directCandidates.length; i++) {
      const smc = directCandidates[i];
      if (smc && typeof smc === 'object') return smc;
    }

    throw new Error('smc not found');
  }

  function getShopModuleRuntime() {
    const resolved = getSystemExportRuntime(
      ['chunks:///_virtual/Shop.ts', './Shop.ts'],
      'Shop'
    );
    if (resolved && resolved.value && typeof resolved.value.staticEnter === 'function') {
      return {
        source: resolved.source,
        Shop: resolved.value
      };
    }

    const directCandidates = [
      G.Shop,
      G.GameGlobal && G.GameGlobal.Shop
    ];
    for (let i = 0; i < directCandidates.length; i++) {
      const Shop = directCandidates[i];
      if (Shop && typeof Shop.staticEnter === 'function') {
        return {
          source: i === 0 ? 'globalThis.Shop' : 'GameGlobal.Shop',
          Shop: Shop
        };
      }
    }

    return null;
  }

  function getShopEnterCompCtor() {
    const resolved = getSystemExportRuntime(
      ['chunks:///_virtual/ShopEnterSystem.ts', './ShopEnterSystem.ts'],
      'ShopEnterComp'
    );
    return resolved && typeof resolved.value === 'function' ? resolved.value : null;
  }

  function hasShopEnterComp(entity) {
    const ShopEnterComp = getShopEnterCompCtor();
    if (!entity || !ShopEnterComp) return false;

    try {
      if (typeof entity.has === 'function') return !!entity.has(ShopEnterComp);
    } catch (_) {}
    try {
      if (typeof entity.get === 'function') return !!entity.get(ShopEnterComp);
    } catch (_) {}

    const compName = ShopEnterComp.compName || 'ShopEnterComp';
    return !!entity[compName];
  }

  function ensureShopEntityReady() {
    const smc = getSingletonModuleComp();
    if (smc.shop && smc.shop.ShopModelComp) {
      if (!hasShopEnterComp(smc.shop) && typeof smc.shop.enter === 'function') {
        smc.shop.enter();
      }
      return {
        smc: smc,
        shop: smc.shop,
        model: smc.shop.ShopModelComp,
        strategy: hasShopEnterComp(smc.shop) ? 'existing' : 'existing_reenter'
      };
    }

    const runtime = getShopModuleRuntime();
    if (!runtime || !runtime.Shop || typeof runtime.Shop.staticEnter !== 'function') {
      throw new Error('Shop.staticEnter not found');
    }

    runtime.Shop.staticEnter();

    if (!smc.shop) throw new Error('smc.shop not found after Shop.staticEnter');
    if (!smc.shop.ShopModelComp) throw new Error('smc.shop.ShopModelComp not found after Shop.staticEnter');

    return {
      smc: smc,
      shop: smc.shop,
      model: smc.shop.ShopModelComp,
      strategy: 'shop_static_enter'
    };
  }

  function findShopGoodsSource(opts) {
    opts = opts || {};
    const smc = getSingletonModuleComp();
    const shop = smc.shop;
    if (!shop || typeof shop !== 'object') throw new Error('smc.shop not found');
    const model = shop.ShopModelComp;
    if (!model || typeof model !== 'object') throw new Error('smc.shop.ShopModelComp not found');

    const list = Array.isArray(model.curGoodsList) ? model.curGoodsList : null;
    if (opts.requireList !== false && !list) {
      throw new Error('smc.shop.ShopModelComp.curGoodsList not ready');
    }

    return {
      path: 'smc.shop.ShopModelComp.curGoodsList',
      smc: smc,
      shop: shop,
      model: model,
      list: list
    };
  }

  async function waitForShopGoodsSource(opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs == null ? 1600 : Math.max(0, Number(opts.timeoutMs) || 0);
    const pollMs = opts.pollMs == null ? 120 : Math.max(30, Number(opts.pollMs) || 30);
    const startedAt = Date.now();
    let lastError = null;

    while (true) {
      try {
        return findShopGoodsSource(opts);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        if (lastError) throw lastError;
        throw new Error(
          opts.requireList === false
            ? 'smc.shop.ShopModelComp not found'
            : 'smc.shop.ShopModelComp.curGoodsList not ready'
        );
      }
      await wait(pollMs);
    }
  }

  async function ensureShopGoodsSource(opts) {
    opts = opts || {};
    const shopId = opts.shopId || 2;
    const ensureData = opts.ensureData !== false;

    try {
      const existing = findShopGoodsSource({
        ...opts,
        requireList: ensureData
      });
      return {
        source: existing,
        strategy: ensureData ? 'existing_data' : 'existing_entity'
      };
    } catch (_) {}

    const entity = ensureShopEntityReady();
    if (!ensureData) {
      return {
        source: findShopGoodsSource({ requireList: false }),
        strategy: entity.strategy
      };
    }

    await requestShopData(shopId);
    return {
      source: await waitForShopGoodsSource({
        ...opts,
        requireList: true,
        timeoutMs: opts.requestTimeoutMs == null ? 1500 : opts.requestTimeoutMs
      }),
      strategy: entity.strategy + '_request_shop_data'
    };
  }

  function resolveOops() {
    const resolved = findSystemModuleExport(
      ['chunks:///_virtual/Oops.ts', './Oops.ts'],
      'oops'
    );
    if (resolved && resolved.value) return resolved.value;

    const resolved2 = findSystemModuleExport(
      ['chunks:///_virtual/GlobalData.ts', './GlobalData.ts'],
      'oops'
    );
    if (resolved2 && resolved2.value) return resolved2.value;
    return null;
  }

  function getItemManager() {
    const oops = resolveOops();
    if (oops && oops.itemM) return oops.itemM;
    throw new Error('oops.itemM not found');
  }

  function getOopsMessage() {
    const oops = resolveOops();
    if (oops && oops.message) return oops.message;
    throw new Error('oops.message not found');
  }

  function getProtobufDefault() {
    const oops = resolveOops();
    if (oops && oops.protobufDefault) return oops.protobufDefault;
    throw new Error('oops.protobufDefault not found');
  }

  function getNetWebSocket() {
    const oops = resolveOops();
    if (oops && oops.netWebSocket) return oops.netWebSocket;
    throw new Error('oops.netWebSocket not found');
  }

  // ── 掉线重连 ──────────────────────────────────────────────────────────────

  const reconnectWatcherState = {
    timer: null,
    running: false,
    intervalMs: 1200,
    waitAfter: 120,
    channelId: 0,
    lastCheckAt: 0,
    lastHandledAt: 0,
    lastResult: null
  };

  function getNetNode(channelId) {
    const netWebSocket = getNetWebSocket();
    const resolvedChannelId = channelId == null
      ? ((netWebSocket && netWebSocket.GAME_CHANNELID) == null ? 0 : Number(netWebSocket.GAME_CHANNELID) || 0)
      : Number(channelId) || 0;
    const channels = netWebSocket && netWebSocket._channels;
    if (channels && typeof channels.get === 'function') {
      const node = channels.get(resolvedChannelId);
      if (node) return node;
    }
    if (Array.isArray(channels)) return channels[resolvedChannelId] || null;
    if (channels && typeof channels === 'object') {
      return channels[resolvedChannelId] || channels[String(resolvedChannelId)] || null;
    }
    return null;
  }

  function getNetNodeStateName(value) {
    const state = value == null ? null : Number(value);
    if (!Number.isFinite(state)) return value == null ? null : String(value);
    if (state === 0) return 'None';
    if (state === 1) return 'Init';
    if (state === 2) return 'Closed';
    if (state === 3) return 'Connecting';
    if (state === 4) return 'Checking';
    if (state === 5) return 'Working';
    return String(state);
  }

  function summarizeWaitMessageMap(waitMap) {
    let pendingKeys = 0, pendingCount = 0, oldestSendTime = 0, oldestMethod = null;
    const visit = function (list, key) {
      const items = Array.isArray(list) ? list : [];
      if (items.length <= 0) return;
      pendingKeys += 1;
      pendingCount += items.length;
      const first = items[0];
      const sendTime = first && typeof first.sendtime === 'number' ? first.sendtime : 0;
      if (sendTime > 0 && (oldestSendTime === 0 || sendTime < oldestSendTime)) {
        oldestSendTime = sendTime;
        oldestMethod = first && first.methName ? String(first.methName) : (key == null ? null : String(key));
      }
    };
    if (waitMap && typeof waitMap.forEach === 'function') {
      waitMap.forEach(function (list, key) { visit(list, key); });
    } else if (waitMap && typeof waitMap === 'object') {
      Object.keys(waitMap).forEach(function (key) { visit(waitMap[key], key); });
    }
    return { pendingKeys, pendingCount, oldestMethod, oldestPendingMs: oldestSendTime > 0 ? Math.max(0, Date.now() - oldestSendTime) : 0 };
  }

  function summarizeNetNode(node) {
    if (!node) return null;
    const rawState = typeof node.getState === 'function' ? node.getState() : node._state;
    const waitSummary = summarizeWaitMessageMap(node._waitMessageMap);
    return {
      state: rawState == null ? null : rawState,
      stateName: getNetNodeStateName(rawState),
      url: node._url || null,
      retryCount: node._retryCount == null ? null : Number(node._retryCount) || 0,
      maxRetryCount: node._maxRetryCount == null ? null : Number(node._maxRetryCount) || 0,
      isPromptShowing: !!node._isPromptShowing,
      isWaitShowing: !!node._isWaitShowing,
      hasSocket: !!node._socket,
      socketReadyState: node._socket && node._socket.readyState != null ? node._socket.readyState : null,
      clientSeq: node.clientSeq == null ? null : Number(node.clientSeq) || 0,
      serverSeq: node.serverSeq == null ? null : Number(node.serverSeq) || 0,
      pendingKeys: waitSummary.pendingKeys,
      pendingCount: waitSummary.pendingCount,
      oldestPendingMs: waitSummary.oldestPendingMs,
      oldestMethod: waitSummary.oldestMethod
    };
  }

  function findServerKickOutUiComp(opts) {
    opts = opts || {};
    const nodes = walk(scene());
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (opts.activeOnly !== false && !node.activeInHierarchy) continue;
      const comp = findComponentByName(node, 'ServerKickOutUICom');
      if (comp) return comp;
    }
    return null;
  }

  function summarizeServerKickOutUiComp(comp) {
    if (!comp || !comp.node) return null;
    const mode = comp.mode == null ? 0 : Number(comp.mode) || 0;
    const normalContent = normalizeText(comp.normalcontent && comp.normalcontent.string);
    const specialContent = normalizeText(comp.content && comp.content.string);
    const operateContent = normalizeText(comp.operate && comp.operate.content);
    return {
      path: fullPath(comp.node),
      mode,
      active: !!comp.node.active,
      activeInHierarchy: !!comp.node.activeInHierarchy,
      title: normalizeText(comp.normaltitle && comp.normaltitle.string),
      content: mode === 0 ? (normalContent || operateContent) : (specialContent || operateContent),
      operateContent,
      okWord: normalizeText(comp.normalokLabel && comp.normalokLabel.string) || normalizeText(comp.btnlabel && comp.btnlabel.string),
      cancelWord: normalizeText(comp.normalcancelLabel && comp.normalcancelLabel.string),
      okNodePath: comp.normalbtnOk && comp.normalbtnOk.node ? fullPath(comp.normalbtnOk.node) : null,
      cancelNodePath: comp.normalbtnCancel && comp.normalbtnCancel.node ? fullPath(comp.normalbtnCancel.node) : null
    };
  }

  function isReconnectPromptText(value) {
    const text = normalizeMatchText(value);
    if (!text) return false;
    const reconnect = text.indexOf('重新连接') >= 0 || text.indexOf('重新链接') >= 0;
    if (!reconnect) return false;
    return text.indexOf('网络连接超时') >= 0 || text.indexOf('网络异常') >= 0 || text.indexOf('网络已断开') >= 0;
  }

  function getGameStateRuntime() {
    const oops = resolveOops();
    const candidates = [oops && oops.gameState, G.gameState, G.GameGlobal && G.GameGlobal.gameState];
    for (let i = 0; i < candidates.length; i++) {
      const value = candidates[i];
      if (value && typeof value === 'object' && 'state' in value) return value;
    }
    return null;
  }

  function getReconnectPromptState(opts) {
    opts = opts || {};
    let netNode = null, serverKickOutComp = null, netError = null, uiError = null;
    try { netNode = getNetNode(opts.channelId); } catch (error) { netError = error instanceof Error ? error.message : String(error); }
    try { serverKickOutComp = findServerKickOutUiComp({ activeOnly: opts.activeOnly !== false }); } catch (error) { uiError = error instanceof Error ? error.message : String(error); }
    const net = summarizeNetNode(netNode);
    const ui = summarizeServerKickOutUiComp(serverKickOutComp);
    const gameStateRuntime = getGameStateRuntime();
    const promptByUi = !!(ui && isReconnectPromptText(ui.content || ui.operateContent));
    const promptByNet = !!(net && net.isPromptShowing);
    const payload = {
      ok: true,
      visible: promptByUi || promptByNet,
      promptByUi, promptByNet, ui, net,
      gameState: gameStateRuntime ? { state: gameStateRuntime.state || null, stateName: gameStateRuntime.stateName || normalizeText(gameStateRuntime.state) || null } : null
    };
    if (netError || uiError) {
      payload.errors = {};
      if (netError) payload.errors.net = netError;
      if (uiError) payload.errors.ui = uiError;
    }
    return opts.silent ? payload : out(payload);
  }

  async function waitForReconnectRecovered(opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs == null ? 20000 : Math.max(0, Number(opts.timeoutMs) || 0);
    const pollMs = opts.pollMs == null ? 250 : Math.max(50, Number(opts.pollMs) || 50);
    const startedAt = Date.now();
    let last = getReconnectPromptState({ silent: true, channelId: opts.channelId });
    while (timeoutMs <= 0 || Date.now() - startedAt <= timeoutMs) {
      last = getReconnectPromptState({ silent: true, channelId: opts.channelId });
      const promptVisible = !!last.visible;
      const gameState = normalizeText(last.gameState && last.gameState.state);
      const netState = normalizeText(last.net && last.net.stateName);
      const gameReady = !gameState || gameState === 'Game';
      const netReady = !last.net || netState === 'Working';
      if (!promptVisible && gameReady && netReady) {
        const payload = { ok: true, waitedMs: Date.now() - startedAt, state: last };
        return opts.silent ? payload : out(payload);
      }
      await wait(pollMs);
    }
    const payload = { ok: false, reason: 'recover_timeout', waitedMs: Date.now() - startedAt, state: last };
    return opts.silent ? payload : out(payload);
  }

  async function clickReconnectPrompt(opts) {
    opts = opts || {};
    const before = getReconnectPromptState({ silent: true, channelId: opts.channelId });
    const netNode = before && before.net ? getNetNode(opts.channelId) : null;
    const serverKickOutComp = before && before.ui ? findServerKickOutUiComp({ activeOnly: opts.activeOnly !== false }) : null;
    if (!before.visible) {
      const miss = { ok: false, handled: false, reason: 'reconnect_prompt_not_visible', before };
      return opts.silent ? miss : out(miss);
    }
    let via = null;
    if (serverKickOutComp && isReconnectPromptText((before.ui && before.ui.content) || (before.ui && before.ui.operateContent))) {
      if (typeof serverKickOutComp.btnClickHandler === 'function') {
        serverKickOutComp.btnClickHandler(null, '1');
        via = 'server_kickout_ui_handler';
      } else if (serverKickOutComp.operate && typeof serverKickOutComp.operate.okFunc === 'function') {
        serverKickOutComp.operate.okFunc();
        via = 'server_kickout_okFunc';
      }
    }
    if (!via && netNode && netNode._isPromptShowing && typeof netNode.reconnect === 'function') {
      try { netNode._retryCount = 0; netNode._isPromptShowing = false; } catch (_) {}
      netNode.reconnect();
      via = 'netnode_reconnect';
    }
    if (!via) {
      const fail = { ok: false, handled: false, reason: 'reconnect_handler_not_found', before };
      return opts.silent ? fail : out(fail);
    }
    const waitAfter = opts.waitAfter == null ? 250 : Math.max(0, Number(opts.waitAfter) || 0);
    if (waitAfter > 0) await wait(waitAfter);
    const recovered = opts.waitForRecovered === false
      ? null
      : await waitForReconnectRecovered({ silent: true, channelId: opts.channelId, timeoutMs: opts.recoverTimeoutMs, pollMs: opts.recoverPollMs });
    const after = getReconnectPromptState({ silent: true, channelId: opts.channelId });
    const payload = { ok: recovered ? !!recovered.ok : true, handled: true, via, before, after, recovered };
    return opts.silent ? payload : out(payload);
  }

  async function autoReconnectIfNeeded(opts) {
    opts = opts || {};
    const state = getReconnectPromptState({ silent: true, channelId: opts.channelId });
    const gameState = normalizeText(state && state.gameState && state.gameState.state);
    if (!state.visible) {
      if (gameState === 'ReLogin' && opts.waitForRecovered !== false) {
        const recovered = await waitForReconnectRecovered({ silent: true, channelId: opts.channelId, timeoutMs: opts.recoverTimeoutMs, pollMs: opts.recoverPollMs });
        const waiting = { ok: !!(recovered && recovered.ok), handled: false, waiting: true, reason: 'reconnect_recovering', state, recovered };
        return opts.silent ? waiting : out(waiting);
      }
      const skip = { ok: true, handled: false, reason: 'reconnect_prompt_not_visible', state };
      return opts.silent ? skip : out(skip);
    }
    return await clickReconnectPrompt(opts);
  }

  function getReconnectWatcherState(opts) {
    opts = opts || {};
    const payload = {
      running: !!reconnectWatcherState.timer,
      busy: reconnectWatcherState.running,
      intervalMs: reconnectWatcherState.intervalMs,
      waitAfter: reconnectWatcherState.waitAfter,
      channelId: reconnectWatcherState.channelId,
      lastCheckAt: reconnectWatcherState.lastCheckAt || null,
      lastHandledAt: reconnectWatcherState.lastHandledAt || null,
      lastResult: reconnectWatcherState.lastResult || null
    };
    return opts.silent ? payload : out(payload);
  }

  function stopReconnectWatcher(opts) {
    opts = opts || {};
    if (reconnectWatcherState.timer) {
      clearTimeout(reconnectWatcherState.timer);
      reconnectWatcherState.timer = null;
    }
    reconnectWatcherState.running = false;
    return getReconnectWatcherState(opts);
  }

  function startReconnectWatcher(opts) {
    opts = opts || {};
    reconnectWatcherState.intervalMs = opts.intervalMs == null ? reconnectWatcherState.intervalMs : Math.max(300, Number(opts.intervalMs) || reconnectWatcherState.intervalMs);
    reconnectWatcherState.waitAfter = opts.waitAfter == null ? reconnectWatcherState.waitAfter : Math.max(0, Number(opts.waitAfter) || reconnectWatcherState.waitAfter);
    reconnectWatcherState.channelId = opts.channelId == null ? reconnectWatcherState.channelId : Number(opts.channelId) || 0;
    if (reconnectWatcherState.timer) { clearTimeout(reconnectWatcherState.timer); reconnectWatcherState.timer = null; }
    const schedule = function (delayMs) {
      reconnectWatcherState.timer = setTimeout(async function () {
        reconnectWatcherState.timer = null;
        if (reconnectWatcherState.running) { schedule(reconnectWatcherState.intervalMs); return; }
        reconnectWatcherState.running = true;
        reconnectWatcherState.lastCheckAt = Date.now();
        try {
          const result = await autoReconnectIfNeeded({ silent: true, channelId: reconnectWatcherState.channelId, waitAfter: reconnectWatcherState.waitAfter, waitForRecovered: false });
          reconnectWatcherState.lastResult = result;
          if (result && result.handled) reconnectWatcherState.lastHandledAt = Date.now();
        } catch (error) {
          reconnectWatcherState.lastResult = { ok: false, handled: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          reconnectWatcherState.running = false;
          schedule(reconnectWatcherState.intervalMs);
        }
      }, Math.max(50, Number(delayMs) || reconnectWatcherState.intervalMs));
    };
    schedule(opts.delayMs == null ? reconnectWatcherState.intervalMs : opts.delayMs);
    return getReconnectWatcherState(opts);
  }

  // ── 掉线重连 end ──────────────────────────────────────────────────────────
    installed: false,
    lastInstallAt: null,
    lastError: null,
    messageEvents: [],
    frameEvents: [],
    clickEvents: [],
    interactionMethodEvents: [],
    capturedProfiles: [],
    interactionSpyInstalled: false,
    interactionSpyRetryTimer: null,
  };

  function safeCall(fn, fallback) {
    try {
      return typeof fn === 'function' ? fn() : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeReadKey(target, key) {
    if (!target || typeof target !== 'object') return undefined;
    try {
      return target[key];
    } catch (_) {
      return undefined;
    }
  }

  function summarizeRuntimeObject(obj, label) {
    if (!obj || typeof obj !== 'object') {
      return { label, exists: false };
    }
    const keys = safeCall(function () { return Object.keys(obj).sort(); }, []);
    const ownPropertyNames = safeCall(function () { return Object.getOwnPropertyNames(obj).sort(); }, keys);
    const proto = safeCall(function () { return Object.getPrototypeOf(obj); }, null);
    const protoMethods = proto
      ? safeCall(function () {
          return Object.getOwnPropertyNames(proto)
            .filter(function (key) { return key !== 'constructor' && typeof obj[key] === 'function'; })
            .sort();
        }, [])
      : [];
    const primitive = {};
    ownPropertyNames.forEach(function (key) {
      const value = safeReadKey(obj, key);
      if (
        value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        primitive[key] = value;
      }
    });
    return {
      label,
      exists: true,
      keyCount: keys.length,
      keys: keys.slice(0, 120),
      ownPropertyNames: ownPropertyNames.slice(0, 160),
      protoMethods: protoMethods.slice(0, 120),
      primitive,
    };
  }

  function summarizeNodeForClick(node) {
    if (!node || typeof node !== 'object') {
      return { exists: false };
    }
    return {
      exists: true,
      name: node.name || null,
      path: safeCall(function () { return fullPath(node); }, null),
      active: !!safeReadKey(node, 'active'),
      activeInHierarchy: !!safeReadKey(node, 'activeInHierarchy'),
      components: safeCall(function () { return componentNames(node); }, []),
      texts: safeCall(function () { return getNodeTextList(node, { maxDepth: 2 }).slice(0, 8); }, []),
      rect: safeCall(function () { return getNodeScreenRect(node); }, null),
      buttonHandlers: safeCall(function () {
        const btn = node.getComponent ? node.getComponent(cc.Button) : null;
        return btn ? getHandlers(btn).map(function (item) { return item.text; }) : [];
      }, []),
    };
  }

  function pushInteractionMethodEvent(event) {
    pushBounded(runtimeSpyState.interactionMethodEvents, event, 120);
  }

  function ensureInteractionManagerSpyRetry() {
    if (runtimeSpyState.interactionSpyInstalled) return;
    if (runtimeSpyState.interactionSpyRetryTimer) return;
    runtimeSpyState.interactionSpyRetryTimer = setInterval(function () {
      const installed = safeCall(function () { return installInteractionManagerSpies(); }, false);
      if (installed) {
        clearInterval(runtimeSpyState.interactionSpyRetryTimer);
        runtimeSpyState.interactionSpyRetryTimer = null;
      }
    }, 1000);
  }

  function installInteractionManagerSpies() {
    const manager = safeCall(function () { return findPlantInteractionManager(); }, null);
    if (!manager || typeof manager !== 'object') return false;
    const managerProto = safeCall(function () { return Object.getPrototypeOf(manager); }, null);
    const methods = [
      'onToolInteractionNodeTouchEnd',
      'onInteractionNodeTouchEnd',
      'showDetailForItem',
      'setCurrentData',
      'selectAppropriateInteractionNode',
      'attemptLandInteraction',
      'performFertilizing',
      'onFertilizePlantCompleted',
    ];
    const wrapHost = function (host, hostType) {
      if (!host || (typeof host !== 'object' && typeof host !== 'function')) return;
      methods.forEach(function (name) {
        const original = safeReadKey(host, name);
        if (typeof original !== 'function' || original.__qqFarmSpyWrapped) return;
        const wrapped = function () {
          const selfManager = this && typeof this === 'object' ? this : manager;
          const args = Array.prototype.slice.call(arguments);
          const beforeState = {
            currentDetailType: safeReadKey(selfManager, 'currentDetailType'),
            currentDragType: safeReadKey(selfManager, 'currentDragType'),
            currentDataItems: summarizeInventoryArray(safeReadKey(selfManager, 'currentData'), 8),
          };
          let result = null;
          let error = null;
          try {
            result = original.apply(this, args);
            return result;
          } catch (err) {
            error = err && err.message ? err.message : String(err || name + ' failed');
            throw err;
          } finally {
            pushInteractionMethodEvent({
              at: Date.now(),
              hostType: hostType,
              method: name,
              args: args.map(function (arg) { return summarizeSpyValue(arg, 1); }).slice(0, 6),
              beforeState: beforeState,
              afterState: {
                currentDetailType: safeReadKey(selfManager, 'currentDetailType'),
                currentDragType: safeReadKey(selfManager, 'currentDragType'),
                currentDataItems: summarizeInventoryArray(safeReadKey(selfManager, 'currentData'), 8),
                currentDetailComp: summarizeRuntimeObject(safeReadKey(selfManager, 'currentDetailComp'), 'currentDetailComp'),
              },
              result: summarizeSpyValue(result, 1),
              error: error,
            });
          }
        };
        wrapped.__qqFarmSpyWrapped = true;
        wrapped.__qqFarmSpyOriginal = original;
        host[name] = wrapped;
      });
    };
    wrapHost(managerProto, 'prototype');
    wrapHost(manager, 'instance');
    runtimeSpyState.interactionSpyInstalled = true;
    if (runtimeSpyState.interactionSpyRetryTimer) {
      clearInterval(runtimeSpyState.interactionSpyRetryTimer);
      runtimeSpyState.interactionSpyRetryTimer = null;
    }
    return true;
  }

  function collectMethodNames(obj) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return [];
    const names = [];
    const pushName = function (key) {
      if (!key || key === 'constructor' || names.indexOf(key) >= 0) return;
      names.push(key);
    };
    safeCall(function () {
      Object.getOwnPropertyNames(obj).forEach(function (key) {
        if (typeof obj[key] === 'function') pushName(key);
      });
    }, null);
    const proto = safeCall(function () { return Object.getPrototypeOf(obj); }, null);
    safeCall(function () {
      if (!proto) return;
      Object.getOwnPropertyNames(proto).forEach(function (key) {
        if (key === 'constructor') return;
        if (typeof obj[key] === 'function') pushName(key);
      });
    }, null);
    return names.sort();
  }

  function filterMethodNamesByKeywords(obj, keywords) {
    const list = collectMethodNames(obj);
    const normalized = (Array.isArray(keywords) ? keywords : [])
      .map(function (item) { return String(item || '').trim().toLowerCase(); })
      .filter(Boolean);
    if (normalized.length === 0) return list;
    return list.filter(function (name) {
      const lower = String(name || '').toLowerCase();
      return normalized.some(function (keyword) { return lower.indexOf(keyword) >= 0; });
    });
  }

  function getMethodSourcePreview(obj, name, maxLen) {
    if (!obj || !name) return null;
    const fn = safeReadKey(obj, name);
    if (typeof fn !== 'function') return null;
    const text = safeCall(function () { return Function.prototype.toString.call(fn); }, '');
    if (!text) return null;
    const limit = Math.max(80, Number(maxLen) || 320);
    return text.length > limit ? text.slice(0, limit) + ' ...' : text;
  }

  function safeGetNested(root, path) {
    if (!root || !path) return null;
    const parts = Array.isArray(path) ? path : String(path).split('.');
    let current = root;
    for (let i = 0; i < parts.length; i += 1) {
      const key = parts[i];
      if (!key || !current) return null;
      current = safeReadKey(current, key);
    }
    return current == null ? null : current;
  }

  function summarizeProtobufRef(path) {
    const protobufRoot = safeCall(function () { return getProtobufDefault(); }, null);
    const value = safeGetNested(protobufRoot, path);
    if (!value) {
      return {
        path: Array.isArray(path) ? path.join('.') : String(path || ''),
        exists: false,
      };
    }
    const methods = collectMethodNames(value);
    const nestedKeys = safeCall(function () {
      return Object.keys(value).filter(function (key) {
        return key && key !== 'options' && key !== 'parent';
      }).sort();
    }, []);
    const fields = safeCall(function () {
      if (!Array.isArray(value.fieldsArray)) return [];
      return value.fieldsArray.map(function (field) {
        return {
          name: field && field.name ? field.name : null,
          type: field && field.type ? field.type : null,
          id: field && field.id != null ? field.id : null,
          repeated: !!(field && field.repeated),
        };
      });
    }, []);
    return {
      path: Array.isArray(path) ? path.join('.') : String(path || ''),
      exists: true,
      type: value && value.constructor ? value.constructor.name : typeof value,
      methods: methods.slice(0, 60),
      nestedKeys: nestedKeys.slice(0, 60),
      fields: fields.slice(0, 40),
      sourcePreview: methods.length > 0 ? getMethodSourcePreview(value, methods[0], 500) : null,
    };
  }

  function summarizeMapEntries(mapLike, limit) {
    if (!mapLike || typeof mapLike.forEach !== 'function') return [];
    const max = Math.max(1, Number(limit) || 12);
    const entries = [];
    safeCall(function () {
      mapLike.forEach(function (value, key) {
        if (entries.length >= max) return;
        entries.push({
          key: key,
          summary: summarizeRuntimeObject(value, 'mapValue'),
          methods: filterMethodNamesByKeywords(value, ['send', 'req', 'msg', 'rpc', 'call', 'proto', 'service']),
        });
      });
    }, null);
    return entries;
  }

  function findNestedValueByKey(root, targetKey, depthLimit) {
    if (!root || typeof root !== 'object' || !targetKey) return null;
    const seen = new Set();
    const queue = [{ value: root, path: 'root', depth: 0 }];
    const maxDepth = Math.max(1, Number(depthLimit) || 4);
    while (queue.length > 0) {
      const current = queue.shift();
      const value = current.value;
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (Object.prototype.hasOwnProperty.call(value, targetKey)) {
        return {
          path: current.path + '.' + targetKey,
          value: safeReadKey(value, targetKey),
        };
      }
      if (current.depth >= maxDepth) continue;
      const keys = safeCall(function () { return Object.keys(value); }, []);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const child = safeReadKey(value, key);
        if (!child || typeof child !== 'object') continue;
        queue.push({
          value: child,
          path: current.path + '.' + key,
          depth: current.depth + 1,
        });
      }
    }
    return null;
  }

  function buildFertilizerDetailCandidates(itemM, item) {
    const candidates = [];
    const pushCandidate = function (label, value) {
      if (!value) return;
      if (candidates.some(function (entry) { return entry && entry.value === value; })) return;
      candidates.push({ label: label, value: value });
    };
    pushCandidate('raw_item', item);
    pushCandidate('temp_data', item ? safeReadKey(item, '_tempData') : null);
    if (itemM && item && safeReadKey(item, 'id') != null) {
      const itemId = safeReadKey(item, 'id');
      if (typeof itemM.getTempItemModel === 'function') {
        pushCandidate('temp_item_model', safeCall(function () { return itemM.getTempItemModel(itemId); }, null));
      }
      if (typeof itemM.getItemConfig === 'function') {
        pushCandidate('item_config', safeCall(function () { return itemM.getItemConfig(itemId); }, null));
      }
      if (typeof itemM.getitembyid === 'function') {
        pushCandidate('getitembyid', safeCall(function () { return itemM.getitembyid(itemId); }, null));
      }
    }
    return candidates;
  }

  function summarizeArrayItems(list, limit) {
    if (!Array.isArray(list)) return null;
    const max = Math.max(1, Number(limit) || 6);
    return list.slice(0, max).map(function (item) {
      return summarizeSpyValue(item, 2);
    });
  }

  function summarizeInventoryEntry(item) {
    if (!item || typeof item !== 'object') return summarizeSpyValue(item, 1);
    const temp = safeReadKey(item, '_tempData');
    return {
      id: safeReadKey(item, 'id'),
      itemId: safeReadKey(item, 'itemId'),
      count: toFiniteNumber(safeReadKey(item, 'count')),
      finalCount: toFiniteNumber(safeReadKey(item, 'finalCount')),
      changeCount: toFiniteNumber(safeReadKey(item, 'changeCount')),
      isSelected: safeReadKey(item, 'isSelected'),
      isNew: safeReadKey(item, 'isNew'),
      detail: safeReadKey(item, 'detail'),
      name: temp ? safeReadKey(temp, 'name') : null,
      type: temp ? safeReadKey(temp, 'type') : null,
      interactionType: temp ? safeReadKey(temp, 'interaction_type') : null,
      effectDesc: temp ? safeReadKey(temp, 'effectDesc') : null,
    };
  }

  function summarizeInventoryArray(list, limit) {
    if (!Array.isArray(list)) return null;
    const max = Math.max(1, Number(limit) || 10);
    return list.slice(0, max).map(function (item) {
      return summarizeInventoryEntry(item);
    });
  }

  function getInteractionTypeOfItem(item) {
    if (!item || typeof item !== 'object') return '';
    const temp = safeReadKey(item, '_tempData');
    return String(
      (temp && safeReadKey(temp, 'interaction_type')) ||
      safeReadKey(item, 'interactionType') ||
      ''
    ).trim().toLowerCase();
  }

  function findBestFertilizerDetailItem(itemM, mode) {
    if (!itemM || typeof itemM.getFertilizer_items !== 'function') return null;
    const list = safeCall(function () { return itemM.getFertilizer_items(); }, null);
    if (!Array.isArray(list) || list.length === 0) return null;
    const expectedType = String(mode || '').toLowerCase() === 'organic' ? 'fertilizerpro' : 'fertilizer';
    const matched = list
      .filter(function (item) {
        return getInteractionTypeOfItem(item) === expectedType && toFiniteNumber(safeReadKey(item, 'count')) > 0;
      })
      .sort(function (a, b) {
        const aid = toFiniteNumber(safeReadKey(a, 'id')) || 0;
        const bid = toFiniteNumber(safeReadKey(b, 'id')) || 0;
        return bid - aid;
      });
    return matched.length > 0 ? matched[0] : null;
  }

  function findFirstCurrentDataFertilizerBucket(manager, mode) {
    const list = safeReadKey(manager, 'currentData');
    if (!Array.isArray(list)) return null;
    const wantOrganic = String(mode || '').toLowerCase() === 'organic';
    const matches = list.filter(function (item) {
      const temp = item && safeReadKey(item, '_tempData');
      const interactionType = String(temp && safeReadKey(temp, 'interaction_type') || '').toLowerCase();
      if (interactionType !== 'fertilizerbucket') return false;
      const id = Number(item && safeReadKey(item, 'id')) || 0;
      if (wantOrganic) return id === 1012;
      return id === 1011;
    });
    return matches.length > 0 ? matches[0] : null;
  }

  function selectCurrentDataItem(manager, targetItem) {
    const list = safeReadKey(manager, 'currentData');
    if (!Array.isArray(list) || !targetItem) return false;
    let matched = false;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const isTarget = item === targetItem;
      if (Object.prototype.hasOwnProperty.call(item || {}, 'isSelected')) {
        safeCall(function () { item.isSelected = !!isTarget; }, null);
      }
      if (isTarget) matched = true;
    }
    return matched;
  }

  function summarizeCurrentDataState(manager) {
    const list = safeReadKey(manager, 'currentData');
    if (!Array.isArray(list)) {
      return {
        isArray: false,
        value: summarizeSpyValue(list, 1),
      };
    }
    const ownKeys = safeCall(function () { return Object.keys(list); }, []);
    const ownNames = safeCall(function () { return Object.getOwnPropertyNames(list); }, ownKeys);
    const extra = {};
    ownNames.forEach(function (key) {
      if (/^\d+$/.test(String(key))) return;
      if (key === 'length') return;
      const value = safeReadKey(list, key);
      extra[key] = summarizeSpyValue(value, 1);
    });
    return {
      isArray: true,
      length: list.length,
      ownKeys: ownKeys.slice(0, 20),
      ownPropertyNames: ownNames.slice(0, 30),
      extra: extra,
    };
  }

  function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function toPositiveNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
  }

  function pushBounded(list, value, limit) {
    if (!Array.isArray(list)) return;
    list.push(value);
    const max = Math.max(1, Number(limit) || 1);
    while (list.length > max) list.shift();
  }

  function summarizeSpyValue(value, depth) {
    const level = Number(depth) || 0;
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      if (level >= 1) return { type: 'array', length: value.length };
      return {
        type: 'array',
        length: value.length,
        sample: value.slice(0, 4).map(function (item) {
          return summarizeSpyValue(item, level + 1);
        }),
      };
    }
    if (typeof value === 'object') {
      const keys = safeCall(function () { return Object.keys(value); }, []);
      const outObj = { type: 'object', keys: keys.slice(0, 12) };
      if (level < 1) {
        const primitive = {};
        keys.slice(0, 12).forEach(function (key) {
          const cur = safeReadKey(value, key);
          if (cur == null || typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') {
            primitive[key] = cur;
          }
        });
        if (Object.keys(primitive).length > 0) outObj.primitive = primitive;
      }
      return outObj;
    }
    if (typeof value === 'function') return { type: 'function', name: value.name || '' };
    return { type: typeof value };
  }

  function summarizeInteractionNodeInfoValue(info) {
    if (!info || typeof info !== 'object') return summarizeSpyValue(info, 1);
    const mainNode = safeReadKey(info, 'mainNode');
    const subNodes = safeReadKey(info, 'subNodes');
    return {
      type: 'object',
      keys: safeCall(function () { return Object.keys(info).slice(0, 16); }, []),
      mainNode: mainNode ? {
        path: fullPath(mainNode),
        name: mainNode.name || null,
        texts: getNodeTextList(mainNode, { maxDepth: 2 }).slice(0, 6),
      } : null,
      subNodes: Array.isArray(subNodes)
        ? subNodes.slice(0, 8).map(function (node) {
            return node ? {
              path: fullPath(node),
              name: node.name || null,
              texts: getNodeTextList(node, { maxDepth: 2 }).slice(0, 6),
            } : null;
          }).filter(Boolean)
        : [],
      nodeCount: Array.isArray(subNodes) ? subNodes.length : toFiniteNumber(safeReadKey(info, 'nodeCount')),
    };
  }

  function getToolNodeByItemId(manager, itemId) {
    if (!manager || typeof manager.getToolNode !== 'function') return null;
    const id = Number(itemId) || 0;
    if (id <= 0) return null;
    return safeCall(function () { return manager.getToolNode(id); }, null);
  }

  function normalizeCapturedProfile(profile, source) {
    if (!profile || typeof profile !== 'object') return null;
    const normalized = {
      gid: toPositiveNumber(profile.gid != null ? profile.gid : (profile.uid != null ? profile.uid : profile.playerId)),
      name: normalizeText(profile.name || profile.limitName || profile.nickname || profile.nick || profile.displayName),
      level: toFiniteNumber(profile.level != null ? profile.level : (profile.lv != null ? profile.lv : profile.grade)),
      exp: toFiniteNumber(
        profile.exp != null ? profile.exp :
        (profile._exp != null ? profile._exp :
        (profile.curExp != null ? profile.curExp : profile.currentExp))
      ),
      nextLevelExp: toFiniteNumber(profile.nextLevelExp),
      playerId: toPositiveNumber(profile.playerId != null ? profile.playerId : profile.roleId),
      gold: toFiniteNumber(profile.gold != null ? profile.gold : (profile.coin != null ? profile.coin : profile.money)),
      coupon: toFiniteNumber(profile.coupon != null ? profile.coupon : (profile.ticket != null ? profile.ticket : profile.pointCoupon)),
      diamond: toFiniteNumber(profile.diamond != null ? profile.diamond : profile.rechargeDiamond),
      bean: toFiniteNumber(
        profile.goldenBean != null ? profile.goldenBean :
        (profile.bean != null ? profile.bean : profile.goldBean)
      ),
      source: source || null,
      capturedAt: Date.now(),
    };
    const hasIdentity = !!(
      normalized.gid != null ||
      normalized.name ||
      normalized.level != null ||
      normalized.exp != null ||
      normalized.gold != null
    );
    const hasAssets = !!(
      normalized.coupon != null ||
      normalized.diamond != null ||
      normalized.bean != null
    );
    if (!hasIdentity && !hasAssets) return null;
    if (normalized.name === '1111' && normalized.gid === 1111) return null;
    return normalized;
  }

  function rememberCapturedProfile(profile, source) {
    const normalized = normalizeCapturedProfile(profile, source);
    if (!normalized) return null;
    pushBounded(runtimeSpyState.capturedProfiles, normalized, 40);
    return normalized;
  }

  function inspectRuntimeSpyValue(value, source) {
    if (!value || typeof value !== 'object') return;
    const queue = [{ value, depth: 0, source: source || 'runtime' }];
    const seen = new Set();
    while (queue.length > 0) {
      const item = queue.shift();
      const cur = item && item.value;
      const depth = item && item.depth || 0;
      const curSource = item && item.source || source || 'runtime';
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      rememberCapturedProfile(cur, curSource);
      if (depth >= 2) continue;
      const keys = safeCall(function () { return Object.keys(cur); }, []);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const child = safeReadKey(cur, key);
        if (!child || typeof child !== 'object') continue;
        queue.push({ value: child, depth: depth + 1, source: curSource + '.' + key });
      }
    }
  }

  function getBestCapturedRuntimeProfile() {
    const list = Array.isArray(runtimeSpyState.capturedProfiles) ? runtimeSpyState.capturedProfiles : [];
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (!item || typeof item !== 'object') continue;
      let score = 0;
      if (item.gid != null) score += 8;
      if (item.name) score += 8;
      if (item.level != null) score += 7;
      if (item.exp != null) score += 6;
      if (item.gold != null) score += 6;
      if (item.coupon != null) score += 3;
      if (item.diamond != null) score += 3;
      if (item.bean != null) score += 3;
      if (item.source && /login|basic|reply|notify/i.test(item.source)) score += 10;
      if (item.source && /dispatch:/i.test(item.source)) score += 2;
      if (item.source && /frame:/i.test(item.source)) score += 2;
      if (!best || score > bestScore || (score === bestScore && (item.capturedAt || 0) > (best.capturedAt || 0))) {
        best = item;
        bestScore = score;
      }
    }
    return best ? { ...best, score: bestScore } : null;
  }

  function getRuntimeSpySnapshot() {
    return {
      installed: runtimeSpyState.installed,
      lastInstallAt: runtimeSpyState.lastInstallAt,
      lastError: runtimeSpyState.lastError,
      messageEvents: runtimeSpyState.messageEvents.slice(-20),
      frameEvents: runtimeSpyState.frameEvents.slice(-20),
      capturedProfiles: runtimeSpyState.capturedProfiles.slice(-12),
      bestProfile: getBestCapturedRuntimeProfile(),
    };
  }

  function installRuntimeSpies() {
    if (runtimeSpyState.installed) return runtimeSpyState;
    runtimeSpyState.lastInstallAt = Date.now();
    try {
      const message = safeCall(function () { return getOopsMessage(); }, null);
      if (message && typeof message.dispatchEvent === 'function' && !message.dispatchEvent.__qqFarmSpyWrapped) {
        const originalDispatchEvent = message.dispatchEvent;
        const wrappedDispatchEvent = function () {
          const args = Array.prototype.slice.call(arguments);
          const eventName = typeof args[0] === 'string' ? args[0] : null;
          pushBounded(runtimeSpyState.messageEvents, {
            at: Date.now(),
            name: eventName,
            args: args.slice(1, 4).map(function (arg) { return summarizeSpyValue(arg, 0); }),
          }, 80);
          for (let i = 1; i < args.length; i += 1) {
            inspectRuntimeSpyValue(args[i], 'dispatch:' + (eventName || 'unknown'));
          }
          return originalDispatchEvent.apply(this, args);
        };
        wrappedDispatchEvent.__qqFarmSpyWrapped = true;
        wrappedDispatchEvent.__qqFarmSpyOriginal = originalDispatchEvent;
        message.dispatchEvent = wrappedDispatchEvent;
      }

      const net = safeCall(function () { return getNetWebSocket(); }, null);
      if (net && typeof net.onFrame === 'function' && !net.onFrame.__qqFarmSpyWrapped) {
        const originalOnFrame = net.onFrame;
        const wrappedOnFrame = function () {
          const args = Array.prototype.slice.call(arguments);
          pushBounded(runtimeSpyState.frameEvents, {
            at: Date.now(),
            args: args.slice(0, 4).map(function (arg) { return summarizeSpyValue(arg, 0); }),
          }, 80);
          for (let i = 0; i < args.length; i += 1) {
            inspectRuntimeSpyValue(args[i], 'frame');
          }
          const result = originalOnFrame.apply(this, args);
          inspectRuntimeSpyValue(result, 'frame.result');
          return result;
        };
        wrappedOnFrame.__qqFarmSpyWrapped = true;
        wrappedOnFrame.__qqFarmSpyOriginal = originalOnFrame;
        net.onFrame = wrappedOnFrame;
      }

      const nodeProto = cc && cc.Node && cc.Node.prototype;
      if (nodeProto && typeof nodeProto.dispatchEvent === 'function' && !nodeProto.dispatchEvent.__qqFarmSpyWrapped) {
        const originalNodeDispatchEvent = nodeProto.dispatchEvent;
        const wrappedNodeDispatchEvent = function (event) {
          const type = event && event.type ? String(event.type).toLowerCase() : '';
          if (type === 'touchend' || type === 'click' || type === 'mouse-up') {
            const target = safeReadKey(event, 'target') || this;
            const currentTarget = safeReadKey(event, 'currentTarget') || this;
            pushBounded(runtimeSpyState.clickEvents, {
              at: Date.now(),
              type: type,
              target: summarizeNodeForClick(target),
              currentTarget: summarizeNodeForClick(currentTarget),
              activeDetailState: safeCall(function () {
                const manager = findPlantInteractionManager();
                return manager ? {
                  currentDetailType: safeReadKey(manager, 'currentDetailType'),
                  currentDragType: safeReadKey(manager, 'currentDragType'),
                  currentDataItems: summarizeInventoryArray(safeReadKey(manager, 'currentData'), 8),
                  currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
                } : null;
              }, null),
            }, 80);
          }
          return originalNodeDispatchEvent.apply(this, arguments);
        };
        wrappedNodeDispatchEvent.__qqFarmSpyWrapped = true;
        wrappedNodeDispatchEvent.__qqFarmSpyOriginal = originalNodeDispatchEvent;
        nodeProto.dispatchEvent = wrappedNodeDispatchEvent;
      }

      const buttonProto = cc && cc.Button && cc.Button.prototype;
      if (buttonProto && typeof buttonProto._onTouchEnded === 'function' && !buttonProto._onTouchEnded.__qqFarmSpyWrapped) {
        const originalButtonTouchEnded = buttonProto._onTouchEnded;
        const wrappedButtonTouchEnded = function (event) {
          const node = safeReadKey(this, 'node') || safeReadKey(event, 'currentTarget') || safeReadKey(event, 'target') || null;
          pushBounded(runtimeSpyState.clickEvents, {
            at: Date.now(),
            type: 'button_touchend',
            target: summarizeNodeForClick(safeReadKey(event, 'target') || node),
            currentTarget: summarizeNodeForClick(node),
            activeDetailState: safeCall(function () {
              const manager = findPlantInteractionManager();
              return manager ? {
                currentDetailType: safeReadKey(manager, 'currentDetailType'),
                currentDragType: safeReadKey(manager, 'currentDragType'),
                currentDataItems: summarizeInventoryArray(safeReadKey(manager, 'currentData'), 8),
                currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
              } : null;
            }, null),
          }, 120);
          return originalButtonTouchEnded.apply(this, arguments);
        };
        wrappedButtonTouchEnded.__qqFarmSpyWrapped = true;
        wrappedButtonTouchEnded.__qqFarmSpyOriginal = originalButtonTouchEnded;
        buttonProto._onTouchEnded = wrappedButtonTouchEnded;
      }

      if (buttonProto && typeof buttonProto._onTouchBegan === 'function' && !buttonProto._onTouchBegan.__qqFarmSpyWrapped) {
        const originalButtonTouchBegan = buttonProto._onTouchBegan;
        const wrappedButtonTouchBegan = function (event) {
          const node = safeReadKey(this, 'node') || safeReadKey(event, 'currentTarget') || safeReadKey(event, 'target') || null;
          pushBounded(runtimeSpyState.clickEvents, {
            at: Date.now(),
            type: 'button_touchstart',
            target: summarizeNodeForClick(safeReadKey(event, 'target') || node),
            currentTarget: summarizeNodeForClick(node),
            activeDetailState: safeCall(function () {
              const manager = findPlantInteractionManager();
              return manager ? {
                currentDetailType: safeReadKey(manager, 'currentDetailType'),
                currentDragType: safeReadKey(manager, 'currentDragType'),
                currentDataItems: summarizeInventoryArray(safeReadKey(manager, 'currentData'), 8),
                currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
              } : null;
            }, null),
          }, 120);
          return originalButtonTouchBegan.apply(this, arguments);
        };
        wrappedButtonTouchBegan.__qqFarmSpyWrapped = true;
        wrappedButtonTouchBegan.__qqFarmSpyOriginal = originalButtonTouchBegan;
        buttonProto._onTouchBegan = wrappedButtonTouchBegan;
      }

      runtimeSpyState.installed = true;
      if (!installInteractionManagerSpies()) {
        ensureInteractionManagerSpyRetry();
      }
      runtimeSpyState.lastError = null;
    } catch (err) {
      runtimeSpyState.lastError = err && err.message ? err.message : String(err);
    }
    return runtimeSpyState;
  }

  function isPlaceholderAccountShape(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const gid = toPositiveNumber(
      safeReadKey(obj, 'gid') != null ? safeReadKey(obj, 'gid') :
      (safeReadKey(obj, 'uid') != null ? safeReadKey(obj, 'uid') : safeReadKey(obj, 'playerId'))
    );
    const name = normalizeText(
      safeReadKey(obj, 'name') ||
      safeReadKey(obj, 'limitName') ||
      safeReadKey(obj, 'nickname') ||
      safeReadKey(obj, 'nick')
    );
    const level = toFiniteNumber(
      safeReadKey(obj, 'level') != null ? safeReadKey(obj, 'level') :
      (safeReadKey(obj, 'lv') != null ? safeReadKey(obj, 'lv') : safeReadKey(obj, 'grade'))
    );
    const gold = toFiniteNumber(safeReadKey(obj, 'gold'));
    const coupon = toFiniteNumber(
      safeReadKey(obj, 'coupon') != null ? safeReadKey(obj, 'coupon') : safeReadKey(obj, 'ticket')
    );
    const diamond = toFiniteNumber(safeReadKey(obj, 'diamond'));
    const bean = toFiniteNumber(
      safeReadKey(obj, 'goldenBean') != null ? safeReadKey(obj, 'goldenBean') :
      (safeReadKey(obj, 'bean') != null ? safeReadKey(obj, 'bean') : safeReadKey(obj, 'goldBean'))
    );
    const exp = toFiniteNumber(
      safeReadKey(obj, 'exp') != null ? safeReadKey(obj, 'exp') :
      (safeReadKey(obj, '_exp') != null ? safeReadKey(obj, '_exp') : safeReadKey(obj, 'curExp'))
    );
    const nameLooksPlaceholder = !!name && (/^1+$/.test(name) || name === '游客' || name === '默认');
    return gid === 1111 && level === 1 && (gold || 0) === 0 && (coupon || 0) === 0 && (diamond || 0) === 0 && (bean || 0) === 0 && (exp || 0) === 0 && nameLooksPlaceholder;
  }

  function collectNestedObjects(roots, maxDepth) {
    const queue = [];
    const seen = new Set();
    const results = [];
    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i];
      if (root && root.value && typeof root.value === 'object') {
        queue.push({ value: root.value, depth: 0, source: root.source || null });
      }
    }
    while (queue.length > 0) {
      const item = queue.shift();
      const value = item.value;
      const depth = item.depth || 0;
      const source = item.source || null;
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      results.push({ value, depth, source });
      if (depth >= maxDepth) continue;
      const keys = Object.keys(value);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const child = safeReadKey(value, key);
        if (!child || typeof child !== 'object') continue;
        const childSource = source ? source + '.' + key : key;
        queue.push({ value: child, depth: depth + 1, source: childSource });
      }
    }
    return results;
  }

  function scoreAccountLikeObject(obj) {
    if (!obj || typeof obj !== 'object') return -1;
    let score = 0;
    const gid = toPositiveNumber(
      safeReadKey(obj, 'gid') != null ? safeReadKey(obj, 'gid') :
      (safeReadKey(obj, 'uid') != null ? safeReadKey(obj, 'uid') :
      (safeReadKey(obj, 'playerId') != null ? safeReadKey(obj, 'playerId') : safeReadKey(obj, 'roleId')))
    );
    const name = normalizeText(
      safeReadKey(obj, 'name') ||
      safeReadKey(obj, 'limitName') ||
      safeReadKey(obj, 'nickname') ||
      safeReadKey(obj, 'nick') ||
      safeReadKey(obj, 'displayName')
    );
    const level = toFiniteNumber(
      safeReadKey(obj, 'level') != null ? safeReadKey(obj, 'level') :
      (safeReadKey(obj, 'lv') != null ? safeReadKey(obj, 'lv') : safeReadKey(obj, 'grade'))
    );
    const gold = toFiniteNumber(
      safeReadKey(obj, 'gold') != null ? safeReadKey(obj, 'gold') :
      (safeReadKey(obj, 'coin') != null ? safeReadKey(obj, 'coin') : safeReadKey(obj, 'money'))
    );
    const coupon = toFiniteNumber(
      safeReadKey(obj, 'coupon') != null ? safeReadKey(obj, 'coupon') :
      (safeReadKey(obj, 'ticket') != null ? safeReadKey(obj, 'ticket') : safeReadKey(obj, 'couponNum'))
    );
    const bean = toFiniteNumber(
      safeReadKey(obj, 'goldenBean') != null ? safeReadKey(obj, 'goldenBean') :
      (safeReadKey(obj, 'bean') != null ? safeReadKey(obj, 'bean') : safeReadKey(obj, 'goldBean'))
    );
    const exp = toFiniteNumber(
      safeReadKey(obj, 'exp') != null ? safeReadKey(obj, 'exp') :
      (safeReadKey(obj, '_exp') != null ? safeReadKey(obj, '_exp') :
      (safeReadKey(obj, 'curExp') != null ? safeReadKey(obj, 'curExp') : safeReadKey(obj, 'currentExp')))
    );

    if (gid != null) score += 4;
    if (name) score += 4;
    if (level != null) score += 4;
    if (gold != null) score += 4;
    if (coupon != null) score += 3;
    if (bean != null) score += 3;
    if (exp != null) score += 3;
    if (safeReadKey(obj, 'openid') != null || safeReadKey(obj, 'openId') != null) score += 2;
    if (safeReadKey(obj, 'avatar') != null || safeReadKey(obj, 'avatarUrl') != null) score += 1;
    if (safeReadKey(obj, 'authorized_status') != null) score += 1;
    if (Array.isArray(safeReadKey(obj, 'unlockSystems'))) score += 2;
    if (isPlaceholderAccountShape(obj)) score -= 20;
    if (name && /蒙面偷菜的好友/.test(name)) score -= 8;
    return score;
  }

  function findBestProtocolAccountObject() {
    const oops = resolveOops();
    const net = safeCall(function () { return getNetWebSocket(); }, null);
    const itemM = safeCall(function () { return getItemManager(); }, null);
    const roots = [];
    if (oops && typeof oops === 'object') roots.push({ value: oops, source: 'oops' });
    if (net && typeof net === 'object') roots.push({ value: net, source: 'net' });
    if (itemM && typeof itemM === 'object') roots.push({ value: itemM, source: 'itemM' });

    const candidates = collectNestedObjects(roots, 3);
    let best = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const entry = candidates[i];
      const score = scoreAccountLikeObject(entry.value);
      if (score < 10) continue;
      if (!best || score > best.score) {
        best = {
          value: entry.value,
          source: entry.source,
          depth: entry.depth,
          score,
        };
      }
    }
    return best;
  }

  function getProtocolAccountProfile() {
    installRuntimeSpies();
    const oops = resolveOops();
    const net = safeCall(function () { return getNetWebSocket(); }, null);
    const itemM = safeCall(function () { return getItemManager(); }, null);
    const bestNested = findBestProtocolAccountObject();
    const bestCaptured = getBestCapturedRuntimeProfile();
    const candidates = [];

    function pushCandidate(value, source) {
      if (!value || typeof value !== 'object') return;
      candidates.push({ value: value, source: source || null });
    }

    if (oops) {
      pushCandidate(oops.userM, 'oops.userM');
      pushCandidate(oops.userModel, 'oops.userModel');
      pushCandidate(oops.userInfo, 'oops.userInfo');
      pushCandidate(oops.playerData, 'oops.playerData');
      pushCandidate(oops.user, 'oops.user');
    }
    if (net) {
      pushCandidate(net.userState, 'net.userState');
      pushCandidate(net._userState, 'net._userState');
      pushCandidate(safeCall(function () { return net.getUserState(); }, null), 'net.getUserState()');
      pushCandidate(net.loginReply, 'net.loginReply');
      pushCandidate(safeReadKey(net, 'basic'), 'net.basic');
      pushCandidate(safeReadKey(net, 'user'), 'net.user');
    }
    if (itemM) {
      pushCandidate(itemM.userState, 'itemM.userState');
      pushCandidate(itemM.user, 'itemM.user');
      pushCandidate(itemM.player, 'itemM.player');
    }
    if (bestNested && bestNested.value) {
      pushCandidate(bestNested.value, bestNested.source || 'protocol.nested');
    }
    if (bestCaptured) {
      pushCandidate(bestCaptured, bestCaptured.source || 'runtime.spy');
    }

    const profile = {
      gid: null,
      name: null,
      level: null,
      exp: null,
      nextLevelExp: null,
      playerId: null,
      gold: null,
      coupon: null,
      diamond: null,
      bean: null,
      source: null,
    };

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const value = candidate.value;
      if (!value || typeof value !== 'object') continue;

      if (profile.gid == null) {
        profile.gid = toPositiveNumber(
          safeReadKey(value, 'gid') != null ? safeReadKey(value, 'gid') :
          (safeReadKey(value, 'uid') != null ? safeReadKey(value, 'uid') :
          (safeReadKey(value, 'playerId') != null ? safeReadKey(value, 'playerId') : safeReadKey(value, 'roleId')))
        );
      }
      if (!profile.name) {
        const nameVal = normalizeText(
          safeReadKey(value, 'name') ||
          safeReadKey(value, 'limitName') ||
          safeReadKey(value, 'nickname') ||
          safeReadKey(value, 'nick') ||
          safeReadKey(value, 'displayName')
        );
        if (nameVal) profile.name = nameVal;
      }
      if (profile.level == null) {
        profile.level = toFiniteNumber(
          safeReadKey(value, 'level') != null ? safeReadKey(value, 'level') :
          (safeReadKey(value, 'lv') != null ? safeReadKey(value, 'lv') : safeReadKey(value, 'grade'))
        );
      }
      if (profile.exp == null) {
        profile.exp = toFiniteNumber(
          safeReadKey(value, 'exp') != null ? safeReadKey(value, 'exp') :
          (safeReadKey(value, '_exp') != null ? safeReadKey(value, '_exp') :
          (safeReadKey(value, 'curExp') != null ? safeReadKey(value, 'curExp') : safeReadKey(value, 'currentExp')))
        );
      }
      if (profile.gold == null) {
        profile.gold = toFiniteNumber(
          safeReadKey(value, 'gold') != null ? safeReadKey(value, 'gold') :
          (safeReadKey(value, 'coin') != null ? safeReadKey(value, 'coin') : safeReadKey(value, 'money'))
        );
      }
      if (profile.coupon == null) {
        profile.coupon = toFiniteNumber(
          safeReadKey(value, 'coupon') != null ? safeReadKey(value, 'coupon') :
          (safeReadKey(value, 'ticket') != null ? safeReadKey(value, 'ticket') : safeReadKey(value, 'couponNum'))
        );
      }
      if (profile.diamond == null) {
        profile.diamond = toFiniteNumber(safeReadKey(value, 'diamond'));
      }
      if (profile.bean == null) {
        profile.bean = toFiniteNumber(
          safeReadKey(value, 'goldenBean') != null ? safeReadKey(value, 'goldenBean') :
          (safeReadKey(value, 'bean') != null ? safeReadKey(value, 'bean') : safeReadKey(value, 'goldBean'))
        );
      }

      if (
        profile.source == null &&
        (profile.gid != null || profile.name || profile.level != null || profile.gold != null || profile.coupon != null || profile.bean != null)
      ) {
        profile.source = candidate.source;
      }
    }

    return profile;
  }

  function getItemCountById(itemId) {
    const targetId = Number(itemId) || 0;
    if (targetId <= 0) return null;
    const itemM = safeCall(function () { return getItemManager(); }, null);
    if (!itemM) return null;

    safeCall(function () {
      if (typeof itemM.updateItems === 'function') itemM.updateItems();
    }, null);

    const methodNames = ['getItemAllCount', 'getItemCountById', 'getItemNumById', 'getItemCount', 'getItemNum', 'getCountById', 'getNumById'];
    for (let i = 0; i < methodNames.length; i += 1) {
      const fn = itemM[methodNames[i]];
      if (typeof fn !== 'function') continue;
      const result = safeCall(function () { return fn.call(itemM, targetId); }, null);
      const count = toFiniteNumber(result);
      if (count != null) return count;
    }

    const legacyItem = safeCall(function () { return itemM.getitembyid(targetId); }, null);
    if (legacyItem && typeof legacyItem === 'object') {
      const count = toFiniteNumber(
        safeReadKey(legacyItem, 'count') != null ? safeReadKey(legacyItem, 'count') :
        (safeReadKey(legacyItem, 'num') != null ? safeReadKey(legacyItem, 'num') : safeReadKey(legacyItem, 'value'))
      );
      if (count != null) return count;
    }

    const directItem = safeCall(function () { return itemM.getItemById(targetId); }, null);
    if (directItem && typeof directItem === 'object') {
      const count = toFiniteNumber(
        safeReadKey(directItem, 'count') != null ? safeReadKey(directItem, 'count') :
        (safeReadKey(directItem, 'num') != null ? safeReadKey(directItem, 'num') : safeReadKey(directItem, 'value'))
      );
      if (count != null) return count;
    }

    const bags = [
      safeReadKey(itemM, 'itemsData'),
      safeReadKey(itemM, 'items'),
      safeReadKey(itemM, 'itemList'),
      safeReadKey(itemM, '_items'),
      safeReadKey(itemM, '_itemList'),
      safeReadKey(itemM, 'bagItems'),
      safeReadKey(itemM, 'itemMap')
    ];
    for (let i = 0; i < bags.length; i += 1) {
      const bag = bags[i];
      if (!bag) continue;
      if (Array.isArray(bag)) {
        for (let j = 0; j < bag.length; j += 1) {
          const item = bag[j];
          const id = Number(
            safeReadKey(item, 'id') != null ? safeReadKey(item, 'id') :
            (safeReadKey(item, 'itemId') != null ? safeReadKey(item, 'itemId') : safeReadKey(item, 'uid'))
          );
          if (id !== targetId) continue;
          const count = toFiniteNumber(
            safeReadKey(item, 'count') != null ? safeReadKey(item, 'count') :
            (safeReadKey(item, 'num') != null ? safeReadKey(item, 'num') : safeReadKey(item, 'value'))
          );
          if (count != null) return count;
        }
      } else if (typeof bag === 'object') {
        const byKey = safeReadKey(bag, String(targetId));
        if (byKey != null) {
          if (typeof byKey === 'number') return byKey;
          const count = toFiniteNumber(
            safeReadKey(byKey, 'count') != null ? safeReadKey(byKey, 'count') :
            (safeReadKey(byKey, 'num') != null ? safeReadKey(byKey, 'num') : safeReadKey(byKey, 'value'))
          );
          if (count != null) return count;
        }
        const keys = Object.keys(bag).slice(0, 500);
        for (let j = 0; j < keys.length; j += 1) {
          const item = safeReadKey(bag, keys[j]);
          if (!item || typeof item !== 'object') continue;
          const id = Number(
            safeReadKey(item, 'id') != null ? safeReadKey(item, 'id') :
            (safeReadKey(item, 'itemId') != null ? safeReadKey(item, 'itemId') :
            (safeReadKey(item, 'cfgId') != null ? safeReadKey(item, 'cfgId') : safeReadKey(item, 'uid')))
          );
          if (id !== targetId) continue;
          const count = toFiniteNumber(
            safeReadKey(item, 'count') != null ? safeReadKey(item, 'count') :
            (safeReadKey(item, 'num') != null ? safeReadKey(item, 'num') : safeReadKey(item, 'value'))
          );
          if (count != null) return count;
        }
      }
    }

    const allItems = safeCall(function () { return itemM.getAllItems(); }, null);
    if (Array.isArray(allItems)) {
      for (let i = 0; i < allItems.length; i += 1) {
        const item = allItems[i];
        const id = Number(
          safeReadKey(item, 'id') != null ? safeReadKey(item, 'id') :
          (safeReadKey(item, 'itemId') != null ? safeReadKey(item, 'itemId') :
          (safeReadKey(item, 'cfgId') != null ? safeReadKey(item, 'cfgId') : safeReadKey(item, 'uid')))
        );
        if (id !== targetId) continue;
        const count = toFiniteNumber(
          safeReadKey(item, 'count') != null ? safeReadKey(item, 'count') :
          (safeReadKey(item, 'num') != null ? safeReadKey(item, 'num') : safeReadKey(item, 'value'))
        );
        if (count != null) return count;
      }
    }
    return null;
  }

  function getItemDebugSnapshot() {
    const itemM = safeCall(function () { return getItemManager(); }, null);
    const result = {
      hasItemManager: !!itemM,
      coupon1002: getItemCountById(1002),
      bean1005: getItemCountById(1005),
      allItemCount1002: null,
      allItemCount1005: null,
      rechargeDiamond: null,
      sources: [],
    };
    if (!itemM) return result;

    result.allItemCount1002 = safeCall(function () {
      return toFiniteNumber(itemM.getItemAllCount(1002));
    }, null);
    result.allItemCount1005 = safeCall(function () {
      return toFiniteNumber(itemM.getItemAllCount(1005));
    }, null);

    const rechargeDiamond = safeCall(function () {
      if (typeof itemM.updateRechargeDiamond === 'function') itemM.updateRechargeDiamond();
      return toFiniteNumber(safeReadKey(itemM, 'rechargeDiamond'));
    }, null);
    if (rechargeDiamond != null) result.rechargeDiamond = rechargeDiamond;

    const allItems = safeCall(function () { return itemM.getAllItems(); }, null);
    if (Array.isArray(allItems)) {
      result.sources.push({
        name: 'getAllItems()',
        type: 'array',
        size: allItems.length,
        sample: allItems.slice(0, 12).map(function (item) {
          return {
            id: safeReadKey(item, 'id'),
            itemId: safeReadKey(item, 'itemId'),
            cfgId: safeReadKey(item, 'cfgId'),
            uid: safeReadKey(item, 'uid'),
            count: safeReadKey(item, 'count'),
            num: safeReadKey(item, 'num'),
            value: safeReadKey(item, 'value'),
            name: safeReadKey(item, 'name'),
          };
        }),
      });
    }

    const bags = [
      ['itemsData', safeReadKey(itemM, 'itemsData')],
      ['items', safeReadKey(itemM, 'items')],
      ['itemList', safeReadKey(itemM, 'itemList')],
      ['_items', safeReadKey(itemM, '_items')],
      ['_itemList', safeReadKey(itemM, '_itemList')],
      ['bagItems', safeReadKey(itemM, 'bagItems')],
      ['itemMap', safeReadKey(itemM, 'itemMap')]
    ];

    for (let i = 0; i < bags.length; i += 1) {
      const name = bags[i][0];
      const bag = bags[i][1];
      if (!bag) continue;
      const entry = {
        name,
        type: Array.isArray(bag) ? 'array' : typeof bag,
        size: null,
        sample: [],
      };
      if (Array.isArray(bag)) {
        entry.size = bag.length;
        for (let j = 0; j < Math.min(bag.length, 8); j += 1) {
          const item = bag[j];
          if (!item || typeof item !== 'object') continue;
          entry.sample.push({
            id: safeReadKey(item, 'id'),
            itemId: safeReadKey(item, 'itemId'),
            cfgId: safeReadKey(item, 'cfgId'),
            uid: safeReadKey(item, 'uid'),
            count: safeReadKey(item, 'count'),
            num: safeReadKey(item, 'num'),
            value: safeReadKey(item, 'value'),
          });
        }
      } else if (bag && typeof bag === 'object') {
        const keys = Object.keys(bag);
        entry.size = keys.length;
        for (let j = 0; j < Math.min(keys.length, 8); j += 1) {
          const key = keys[j];
          const item = safeReadKey(bag, key);
          if (item && typeof item === 'object') {
            entry.sample.push({
              key,
              id: safeReadKey(item, 'id'),
              itemId: safeReadKey(item, 'itemId'),
              cfgId: safeReadKey(item, 'cfgId'),
              uid: safeReadKey(item, 'uid'),
              count: safeReadKey(item, 'count'),
              num: safeReadKey(item, 'num'),
              value: safeReadKey(item, 'value'),
            });
          } else {
            entry.sample.push({ key, value: item });
          }
        }
      }
      result.sources.push(entry);
    }

    return result;
  }

  /**
   * 获取背包中所有种子
   * sortMode: 1=按层级降序, 2=按稀有度降序, 3=按等级降序, 4=按id升序
   */
  function getAllSeeds(sortMode) {
    const itemM = getItemManager();
    if (typeof itemM.getAllSeeds !== 'function') throw new Error('itemM.getAllSeeds not found');
    return itemM.getAllSeeds(sortMode || 0);
  }

  /**
   * 获取种子列表（供外部调用的精简版）
   */
  function getSeedList(opts) {
    opts = opts || {};
    const seeds = getAllSeeds(opts.sortMode || 3);
    const list = seeds.map(function (s) {
      const detail = s.detail || s.tempData || {};
      return {
        itemId: s.itemId || s.id,
        seedId: s.id,
        name: s.name || '未知种子',
        count: s.count || 0,
        level: detail.level || s.level || 0,
        rarity: detail.rarity || 0,
        layer: detail.layer || 0,
      };
    });
    return opts.silent ? list : out(list);
  }

  function getBackpackSeedCount(seedId) {
    const targetSeedId = Number(seedId) || 0;
    if (targetSeedId <= 0) return 0;
    const seeds = getAllSeeds(3);
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      if (Number(seed && seed.id) !== targetSeedId) continue;
      return Number(seed && seed.count) || 0;
    }
    return 0;
  }

  function resolveSeedDisplayName(seedId, fallbackName) {
    if (fallbackName) return String(fallbackName);
    const plantableSeed = resolvePlantableSeedItem(seedId);
    if (plantableSeed) {
      if (plantableSeed.plantName) return String(plantableSeed.plantName);
      if (plantableSeed.name) return String(plantableSeed.name).replace(/种子$/, '');
    }
    return '';
  }

  function resolvePlantableSeedItem(seedId) {
    const targetSeedId = Number(seedId) || 0;
    if (targetSeedId <= 0) return null;
    const seeds = getAllSeeds(3);
    for (let i = 0; i < seeds.length; i += 1) {
      const seed = seeds[i];
      const runtimeSeedId = Number(seed && seed.id) || 0;
      const runtimeItemId = Number(seed && seed.itemId) || 0;
      if (runtimeSeedId !== targetSeedId && runtimeItemId !== targetSeedId) continue;
      return {
        requestedSeedId: targetSeedId,
        runtimeSeedId: runtimeSeedId > 0 ? runtimeSeedId : null,
        itemId: runtimeItemId > 0 ? runtimeItemId : (runtimeSeedId > 0 ? runtimeSeedId : null),
        name: seed && seed.name ? String(seed.name) : null,
        count: Number(seed && seed.count) || 0,
      };
    }
    return null;
  }

  function isShopGoodsLike(item) {
    if (!item || typeof item !== 'object') return false;
    const goodsId = Number(
      safeReadKey(item, 'id') != null ? safeReadKey(item, 'id') :
      (safeReadKey(item, 'goodsId') != null ? safeReadKey(item, 'goodsId') : safeReadKey(item, 'gid'))
    );
    const itemId = Number(
      safeReadKey(item, 'itemId') != null ? safeReadKey(item, 'itemId') :
      (safeReadKey(item, 'seedId') != null ? safeReadKey(item, 'seedId') : safeReadKey(item, 'cfgId'))
    );
    const price = Number(
      safeReadKey(item, 'price') != null ? safeReadKey(item, 'price') :
      (safeReadKey(item, 'cost') != null ? safeReadKey(item, 'cost') : safeReadKey(item, 'buyPrice'))
    );
    return goodsId > 0 && itemId > 0 && Number.isFinite(price) && price >= 0;
  }

  function collectShopGoodsArrays(root, maxDepth) {
    const results = [];
    const seen = new Set();

    function visit(value, path, depth) {
      if (!value || depth > maxDepth) return;
      if (Array.isArray(value)) {
        const goods = value.filter(isShopGoodsLike);
        if (goods.length > 0) {
          results.push({
            path: path || 'root',
            score: goods.length,
            list: value,
          });
        }
        return;
      }
      if (typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      const keys = safeCall(function () { return Object.keys(value); }, []).slice(0, 80);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        visit(safeReadKey(value, key), path ? (path + '.' + key) : key, depth + 1);
      }
    }

    visit(root, '', 0);
    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  }

  function resolveShopGoodsName(g, itemId, tempModel, plantData) {
    const itemData = safeReadKey(g, 'itemData');
    const configByItem = safeCall(function () {
      const itemM = getItemManager();
      if (!itemM) return null;
      if (typeof itemM.getItemConfig === 'function') return itemM.getItemConfig(itemId);
      if (typeof itemM.getTempItemModel === 'function') return itemM.getTempItemModel(itemId);
      if (typeof itemM.getitembyid === 'function') return itemM.getitembyid(itemId);
      return null;
    }, null);

    return (
      safeReadKey(g, 'name') ||
      (tempModel && safeReadKey(tempModel, 'name')) ||
      (itemData && safeReadKey(itemData, 'name')) ||
      (itemData && safeReadKey(itemData, '_name')) ||
      (configByItem && safeReadKey(configByItem, 'name')) ||
      (configByItem && safeReadKey(configByItem, '_name')) ||
      (plantData && safeReadKey(plantData, 'name')) ||
      '未知'
    );
  }

  function normalizeShopGoodsItem(g) {
    if (!g || typeof g !== 'object') return null;
    const goodsId = Number(
      safeReadKey(g, 'id') != null ? safeReadKey(g, 'id') :
      (safeReadKey(g, 'goodsId') != null ? safeReadKey(g, 'goodsId') : safeReadKey(g, 'gid'))
    ) || 0;
    const itemId = Number(
      safeReadKey(g, 'itemId') != null ? safeReadKey(g, 'itemId') :
      (safeReadKey(g, 'seedId') != null ? safeReadKey(g, 'seedId') : safeReadKey(g, 'cfgId'))
    ) || 0;
    if (goodsId <= 0 || itemId <= 0) return null;

    const tempModel = safeReadKey(g, 'tempModel');
    if (tempModel && typeof tempModel.initPlantData === 'function') {
      safeCall(function () { return tempModel.initPlantData(); }, null);
    }
    const plantData =
      safeReadKey(g, 'plantData') ||
      (tempModel && safeReadKey(tempModel, 'plantData')) ||
      null;
    const level = Number(
      tempModel && safeReadKey(tempModel, 'level') != null ? safeReadKey(tempModel, 'level') :
      (plantData && safeReadKey(plantData, 'level') != null ? safeReadKey(plantData, 'level') :
      (safeReadKey(g, 'level') != null ? safeReadKey(g, 'level') :
      (safeReadKey(g, '_unlockLevel') != null ? safeReadKey(g, '_unlockLevel') : safeReadKey(g, 'unlockLevel'))))
    ) || 0;
    const unlocked = safeReadKey(g, 'unlocked');
    const isBuyAll = safeReadKey(g, 'isBuyAll');
    if (unlocked === false) return null;
    if (isBuyAll === true) return null;

    const inferredIsSeed = safeReadKey(g, 'isSeed');
    const isSeed = inferredIsSeed != null
      ? inferredIsSeed
      : !!(itemId > 0 && (plantData || tempModel || safeReadKey(g, 'itemData')));

    return {
      goodsId: goodsId,
      itemId: itemId,
      name: resolveShopGoodsName(g, itemId, tempModel, plantData),
      price: Number(
        safeReadKey(g, 'price') != null ? safeReadKey(g, 'price') :
        (safeReadKey(g, 'cost') != null ? safeReadKey(g, 'cost') : safeReadKey(g, 'buyPrice'))
      ) || 0,
      priceId: Number(
        safeReadKey(g, 'priceId') != null ? safeReadKey(g, 'priceId') :
        (safeReadKey(g, 'costId') != null ? safeReadKey(g, 'costId') : safeReadKey(g, 'currencyId'))
      ) || 0,
      unlockLevel: Number(
        safeReadKey(g, 'unlockLevel') != null ? safeReadKey(g, 'unlockLevel') : safeReadKey(g, '_unlockLevel')
      ) || 0,
      buyNum: Number(safeReadKey(g, 'buyNum')) || 0,
      limitCount: Number(
        safeReadKey(g, 'limitCount') != null ? safeReadKey(g, 'limitCount') : safeReadKey(g, 'buyLimit')
      ) || 0,
      level: level,
      plantId: Number(
        plantData && safeReadKey(plantData, 'id') != null ? safeReadKey(plantData, 'id') : 0
      ) || null,
      unlocked: unlocked !== false,
      isSeed: isSeed,
    };
  }

  /**
   * 获取商店种子商品列表
   * 需要先请求商店数据（shop_id=2 是种子商店）
   */
  function readShopSeedList(opts) {
    opts = opts || {};
    const source = opts.shopSource || safeCall(function () {
      return findShopGoodsSource({
        ...opts,
        requireList: opts.requireList !== false
      });
    }, null);
    const allGoods = source && Array.isArray(source.list)
      ? source.list
      : null;
    if (!Array.isArray(allGoods)) throw new Error('shop goods list not found');

    const playerLevel = getCurrentPlayerLevel();

    const list = allGoods
      .map(normalizeShopGoodsItem)
      .filter(Boolean)
      .filter(function (g) {
        if (g.isSeed === false || g.unlocked === false) return false;
        const unlockLevel = Number(g.unlockLevel) || 0;
        if (unlockLevel <= 0) return true;
        if ((Number(playerLevel) || 0) <= 0) return true;
        return unlockLevel <= playerLevel;
      });
    if (opts.sortByLevel) {
      list.sort(function (a, b) { return b.level - a.level; });
    }
    return opts.silent ? list : out(list);
  }

  async function getShopSeedList(opts) {
    opts = opts || {};
    const ready = await ensureShopGoodsSource({
      ...opts,
      ensureData: opts.ensureData !== false
    });
    return readShopSeedList({
      ...opts,
      silent: true,
      sortByLevel: opts.sortByLevel !== false,
      shopSource: ready && ready.source ? ready.source : null,
      requireList: true,
    });
  }

  function findShopPopupRoot() {
    return (
      findNode('startup/root/ui/LayerPopUp/view_shop') ||
      findNode('root/ui/LayerPopUp/view_shop') ||
      null
    );
  }

  async function ensureShopUiOpen(opts) {
    opts = opts || {};
    const existing = findShopPopupRoot();
    if (existing && existing.activeInHierarchy) {
      return {
        ok: true,
        action: 'already_open',
        rootPath: fullPath(existing),
      };
    }

    const mainMenu = findMainMenuComp();
    if (mainMenu && typeof mainMenu.openShop === 'function') {
      safeCall(function () { return mainMenu.openShop(); }, null);
    } else {
      triggerButton('startup/root/ui/LayerUI/main_ui_v2/Menu/Node_shop/btn_shop');
    }

    const timeoutMs = Math.max(400, Number(opts.timeoutMs) || 2500);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const root = findShopPopupRoot();
      if (root && root.activeInHierarchy) {
        return {
          ok: true,
          action: 'opened',
          rootPath: fullPath(root),
        };
      }
      await wait(120);
    }

    return {
      ok: false,
      action: 'timeout',
      rootPath: null,
    };
  }

  function getShopItemNodes() {
    const root = findShopPopupRoot();
    if (!root) return [];
    return walk(root).filter(function (node) {
      return !!(node && node.activeInHierarchy && node.name === 'item_shop');
    });
  }

  async function waitForShopItemNodes(opts) {
    opts = opts || {};
    const timeoutMs = Math.max(600, Number(opts.timeoutMs) || 4000);
    const deadline = Date.now() + timeoutMs;
    let shopRequestTriggered = false;
    while (Date.now() < deadline) {
      const nodes = getShopItemNodes();
      if (nodes.length > 0) return nodes;
      if (!shopRequestTriggered) {
        shopRequestTriggered = true;
        safeCall(function () {
          const message = getOopsMessage();
          message.dispatchEvent('RequestShopData', 2);
          return true;
        }, null);
      }
      await wait(160);
    }
    return [];
  }

  function normalizeSeedDisplayName(name) {
    return normalizeMatchText(String(name || '').replace(/种子$/g, ''));
  }

  function parseUnlockLevelFromTexts(texts) {
    const list = Array.isArray(texts) ? texts : [];
    for (let i = 0; i < list.length; i += 1) {
      const text = String(list[i] || '').trim();
      const match = text.match(/(\d+)\s*级解锁/);
      if (match) return Number(match[1]) || 0;
    }
    return 0;
  }

  function getCurrentPlayerLevel() {
    const profile = safeCall(function () { return getPlayerProfile({ silent: true }); }, null);
    return Number(profile && (profile.plantLevel != null ? profile.plantLevel : (
      profile.farmMaxLandLevel != null ? profile.farmMaxLandLevel : profile.level
    ))) || 0;
  }

  function isShopItemUnlocked(node) {
    const texts = getNodeTextList(node, { maxDepth: 2 });
    const unlockLevel = parseUnlockLevelFromTexts(texts);
    if (unlockLevel <= 0) return true;
    const playerLevel = getCurrentPlayerLevel();
    if (playerLevel <= 0) return false;
    return playerLevel >= unlockLevel;
  }

  function findShopItemNodeByName(seedName) {
    const target = normalizeSeedDisplayName(seedName);
    const nodes = getShopItemNodes();
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!isShopItemUnlocked(node)) continue;
      const texts = getNodeTextList(node, { maxDepth: 2 }).map(normalizeSeedDisplayName);
      if (texts.indexOf(target) >= 0) return node;
    }
    return null;
  }

  function openShopItemDetail(node) {
    if (!node) return false;
    const components = Array.isArray(node.components) ? node.components : [];
    for (let i = 0; i < components.length; i += 1) {
      const comp = components[i];
      if (!comp || typeof comp !== 'object') continue;
      if (typeof comp.onClickThis === 'function') {
        safeCall(function () { return comp.onClickThis(); }, null);
        return true;
      }
    }
    emitNodeTouch(node, 80);
    return false;
  }

  async function waitForShopBuyPopup(opts) {
    opts = opts || {};
    const timeoutMs = Math.max(400, Number(opts.timeoutMs) || 2500);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const node = findNode('startup/root/ui/LayerPopUp/view_goodsbuy') ||
        findNode('root/ui/LayerPopUp/view_goodsbuy');
      if (node && node.activeInHierarchy) return node;
      await wait(120);
    }
    return null;
  }

  async function buySeedsFromShopUi(opts) {
    opts = opts || {};
    const seedName = String(opts.seedName || '').trim();
    const seedId = Number(opts.seedId) || 0;
    const targetCount = Math.max(1, Number(opts.count) || 1);
    if (!seedName) throw new Error('seedName required');

    const buyConfirmPath = 'startup/root/ui/LayerPopUp/view_goodsbuy/btn_buy';
    const fallbackBuyConfirmPath = 'root/ui/LayerPopUp/view_goodsbuy/btn_buy';
    const attempts = [];
    let boughtCount = 0;

    for (let i = 0; i < targetCount; i += 1) {
      const openResult = await ensureShopUiOpen({ timeoutMs: 3000 });
      if (!openResult || !openResult.ok) {
        return {
          ok: false,
          reason: 'shop_ui_open_failed',
          boughtCount: boughtCount,
          attempts: attempts,
        };
      }

      let itemNode = findShopItemNodeByName(seedName);
      if (!itemNode) {
        await waitForShopItemNodes({ timeoutMs: 3500 });
        itemNode = findShopItemNodeByName(seedName);
      }
      if (!itemNode) {
        return {
          ok: false,
          reason: 'shop_item_not_found',
          seedName: seedName,
          boughtCount: boughtCount,
          visibleItems: getShopItemNodes().slice(0, 16).map(function (node) {
            return getNodeTextList(node, { maxDepth: 2 });
          }),
          attempts: attempts,
        };
      }

      const beforeCount = seedId > 0 ? getBackpackSeedCount(seedId) : null;
      const invokedDirect = openShopItemDetail(itemNode);
      const popup = await waitForShopBuyPopup({ timeoutMs: 2500 });
      if (!popup) {
        attempts.push({
          index: i,
          step: 'open_buy_popup',
          ok: false,
          invokedDirect: invokedDirect,
          itemTexts: getNodeTextList(itemNode, { maxDepth: 2 }),
        });
        return {
          ok: false,
          reason: 'shop_buy_popup_not_found',
          boughtCount: boughtCount,
          attempts: attempts,
        };
      }

      const buyPath = findNode(buyConfirmPath) ? buyConfirmPath : fallbackBuyConfirmPath;
      triggerButton(buyPath);
      await wait(900);
      const afterCount = seedId > 0 ? getBackpackSeedCount(seedId) : null;
      const delta = beforeCount != null && afterCount != null ? Math.max(0, afterCount - beforeCount) : null;
      const success = delta == null ? true : delta > 0;
      attempts.push({
        index: i,
        step: 'buy_once',
        ok: success,
        invokedDirect: invokedDirect,
        beforeCount: beforeCount,
        afterCount: afterCount,
        delta: delta,
      });
      if (!success) {
        return {
          ok: false,
          reason: 'shop_buy_not_applied',
          boughtCount: boughtCount,
          attempts: attempts,
        };
      }
      boughtCount += delta == null ? 1 : delta;
    }

    return {
      ok: true,
      boughtCount: boughtCount,
      attempts: attempts,
    };
  }

  async function inspectShopUi(opts) {
    opts = opts || {};
    const openResult = await ensureShopUiOpen({ timeoutMs: opts.timeoutMs });
    const root = findShopPopupRoot();
    const content = findNode('startup/root/ui/LayerPopUp/view_shop/shop/listNode/view/content') ||
      findNode('root/ui/LayerPopUp/view_shop/shop/listNode/view/content');
    const buyPopup = findNode('startup/root/ui/LayerPopUp/view_goodsbuy') ||
      findNode('root/ui/LayerPopUp/view_goodsbuy');

    const itemNodes = content && Array.isArray(content.children) ? content.children : [];
    const items = itemNodes.slice(0, 12).map(function (node, index) {
      return {
        index: index,
        node: describeNode(node),
        componentDetails: (node.components || []).map(function (comp, compIndex) {
          return summarizeRuntimeObject(comp, 'shopItemComp#' + compIndex);
        }),
      };
    });

    const result = {
      openResult: openResult,
      root: root ? describeNode(root) : null,
      content: content ? describeNode(content) : null,
      itemCount: itemNodes.length,
      items: items,
      buyPopup: buyPopup ? describeNode(buyPopup) : null,
      buyPopupComponents: buyPopup
        ? (buyPopup.components || []).map(function (comp, compIndex) {
          return summarizeRuntimeObject(comp, 'shopBuyComp#' + compIndex);
        })
        : [],
    };
    return opts.silent ? result : out(result);
  }

  async function inspectShopModelRuntime(opts) {
    opts = opts || {};
    let entity = null;
    let source = null;
    let requestOk = null;
    let requestError = null;

    try {
      entity = ensureShopEntityReady();
      source = entity && entity.strategy ? entity.strategy : null;
    } catch (error) {
      requestError = error && error.message ? error.message : String(error);
    }

    if (entity) {
      try {
        requestOk = await requestShopData(opts.shopId || 2);
      } catch (error) {
        requestError = error && error.message ? error.message : String(error);
      }
    }

    const smc = safeCall(function () { return getSingletonModuleComp(); }, null);
    const shop = smc && smc.shop ? smc.shop : null;
    const model = shop && shop.ShopModelComp ? shop.ShopModelComp : null;
    const candidateArrays = [];

    if (model && typeof model === 'object') {
      const keys = safeCall(function () { return Object.keys(model); }, []);
      keys.forEach(function (key) {
        const value = safeReadKey(model, key);
        if (!Array.isArray(value)) return;
        candidateArrays.push({
          key: key,
          length: value.length,
          sample: value.slice(0, 3).map(function (item) {
            return summarizeRuntimeObject(item, key + '_item');
          })
        });
      });
    }

    const payload = {
      source: source,
      requestOk: requestOk,
      requestError: requestError,
      smc: summarizeRuntimeObject(smc, 'smc'),
      shop: summarizeRuntimeObject(shop, 'shop'),
      model: summarizeRuntimeObject(model, 'ShopModelComp'),
      candidateArrays: candidateArrays,
      curGoodsListPreview: model && Array.isArray(model.curGoodsList)
        ? model.curGoodsList.slice(0, 5).map(function (item) {
            return summarizeRuntimeObject(item, 'curGoodsListItem');
          })
        : []
    };
    return opts.silent ? payload : out(payload);
  }

  /**
   * 请求商店数据（异步，需等待 ShopDataReady 事件）
   */
  async function requestShopData(shopId) {
    shopId = shopId || 2;
    ensureShopEntityReady();
    const message = getOopsMessage();
    return new Promise(function (resolve) {
      let settled = false;
      function resolveWithDelay(ok) {
        if (settled) return;
        settled = true;
        setTimeout(function () {
          resolve(ok);
        }, 180);
      }
      const handler = function () {
        message.off('ShopDataReady', handler);
        resolveWithDelay(true);
      };
      message.on('ShopDataReady', handler);
      message.dispatchEvent('RequestShopData', shopId);
      // 超时兜底
      setTimeout(function () {
        message.off('ShopDataReady', handler);
        resolveWithDelay(false);
      }, 5000);
    });
  }

  /**
   * 购买商店商品
   */
  async function buyShopGoods(goodsId, num, price) {
    ensureShopEntityReady();
    const message = getOopsMessage();
    return new Promise(function (resolve) {
      const handler = function (ev, itemId, count) {
        message.off('ShopBuySuccess', handler);
        resolve({ ok: true, itemId: itemId, count: count });
      };
      message.on('ShopBuySuccess', handler);
      message.dispatchEvent('ShopBuyGoods', goodsId, num, price);
      setTimeout(function () {
        message.off('ShopBuySuccess', handler);
        resolve({ ok: false, reason: 'timeout' });
      }, 5000);
    });
  }

  /**
   * 在指定空地上种植作物
   * plantOrSeedId: 优先传作物配置 id，兼容旧版 seed/item id
   * landIds: 要种植的地块 id 数组
   */
  function getGridInfoByLandId(landId) {
    const targetLandId = toPositiveNumber(landId);
    if (targetLandId == null) return null;

    const status = getFarmStatus({ includeGrids: true, includeLandIds: false, silent: true });
    const grids = Array.isArray(status && status.grids) ? status.grids : [];
    for (let i = 0; i < grids.length; i += 1) {
      const grid = grids[i];
      if (toPositiveNumber(grid && grid.landId) === targetLandId) return grid;
    }
    return null;
  }

  function getEmptyLandIds() {
    const status = getFarmStatus({ includeGrids: true, includeLandIds: false, silent: true });
    const grids = Array.isArray(status && status.grids) ? status.grids : [];
    const ids = [];
    for (let i = 0; i < grids.length; i += 1) {
      const grid = grids[i];
      if (grid && grid.stageKind === 'empty' && grid.landId != null) {
        ids.push(Number(grid.landId));
      }
    }
    return ids.filter(function (id) { return Number.isFinite(id) && id > 0; });
  }

  function getPlantCompByLandId(landId) {
    const grid = getGridInfoByLandId(landId);
    if (grid && grid.plantNode) {
      return safeCall(function () { return getPlantComponent(grid.plantNode); }, null);
    }
    return null;
  }

  async function waitForLandHarvestResult(landId, before, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs == null ? 2500 : Math.max(0, Number(opts.timeoutMs) || 0);
    const pollMs = opts.pollMs == null ? 150 : Math.max(30, Number(opts.pollMs) || 30);
    const startedAt = Date.now();
    const beforeInfo = before || getGridInfoByLandId(landId);
    let last = beforeInfo;
    const beforeLeftFruit = beforeInfo && beforeInfo.leftFruit != null ? Number(beforeInfo.leftFruit) : null;
    const beforeHasPlant = beforeInfo ? !!beforeInfo.hasPlant : null;
    const beforePlantId = beforeInfo && beforeInfo.plantId != null ? Number(beforeInfo.plantId) : null;

    while (true) {
      last = getGridInfoByLandId(landId);
      const afterLeftFruit = last && last.leftFruit != null ? Number(last.leftFruit) : null;
      const afterPlantId = last && last.plantId != null ? Number(last.plantId) : null;
      const changed =
        !last ||
        !!(last && last.stageKind !== (beforeInfo && beforeInfo.stageKind)) ||
        !!(last && !!last.hasPlant !== beforeHasPlant) ||
        (beforePlantId != null && afterPlantId != null && beforePlantId !== afterPlantId) ||
        (beforeLeftFruit != null && afterLeftFruit != null && beforeLeftFruit !== afterLeftFruit);
      if (changed) {
        return {
          ok: true,
          reason: 'harvested',
          landId: toPositiveNumber(landId),
          elapsedMs: Date.now() - startedAt,
          after: last
        };
      }

      if (Date.now() - startedAt >= timeoutMs) {
        return {
          ok: false,
          reason: 'harvest_timeout',
          landId: toPositiveNumber(landId),
          elapsedMs: Date.now() - startedAt,
          after: last
        };
      }

      await wait(pollMs);
    }
  }

  function dispatchSingleLandHarvest(landId, isAll) {
    const message = getOopsMessage();
    const payload = {
      land_id: landId,
      is_all: isAll !== false
    };
    message.dispatchEvent('REQUEST_HARVEST_PLANT', payload);
    return payload;
  }

  async function harvestSingleLand(landId, opts) {
    opts = opts || {};
    const targetLandId = toPositiveNumber(landId);
    if (targetLandId == null) throw new Error('landId required');

    const before = getGridInfoByLandId(targetLandId);
    if (!before) {
      return {
        ok: false,
        reason: 'land_not_found',
        landId: targetLandId
      };
    }

    if (!(before.canCollect || before.canHarvest || before.canSteal || before.stageKind === 'mature')) {
      return {
        ok: false,
        reason: 'land_not_harvestable',
        landId: targetLandId,
        before
      };
    }

    const request = dispatchSingleLandHarvest(targetLandId, opts.isAll !== false);
    if (opts.waitForResult === false) {
      return {
        ok: true,
        action: 'harvest_single',
        landId: targetLandId,
        before,
        request,
        dispatched: true
      };
    }

    const verify = await waitForLandHarvestResult(targetLandId, before, opts);
    return {
      ok: verify.ok,
      action: 'harvest_single',
      landId: targetLandId,
      before,
      after: verify.after,
      request,
      verify
    };
  }

  async function clickMatureEffect(landId, opts) {
    opts = opts || {};
    const targetLandId = toPositiveNumber(landId);
    if (targetLandId == null) throw new Error('landId required');

    const before = getGridInfoByLandId(targetLandId);
    const plantComp = getPlantCompByLandId(targetLandId);
    const effect = plantComp && (plantComp.stealEffect || plantComp.matureEffect || null);
    if (effect && typeof effect.clickCallback === 'function') {
      effect.clickCallback();
      if (opts.waitForResult === false) {
        return {
          ok: true,
          action: 'click_mature_effect',
          landId: targetLandId,
          before,
          effectType: plantComp.stealEffect === effect ? 'stealEffect' : 'matureEffect',
          dispatched: true
        };
      }

      const verify = await waitForLandHarvestResult(targetLandId, before, opts);
      const rewardDismiss = await dismissRewardPopup({
        silent: true,
        waitAfter: opts.rewardWaitAfter == null ? 180 : opts.rewardWaitAfter,
      });
      return {
        ok: verify.ok,
        action: 'click_mature_effect',
        landId: targetLandId,
        before,
        after: verify.after,
        effectType: plantComp.stealEffect === effect ? 'stealEffect' : 'matureEffect',
        verify,
        rewardDismiss
      };
    }

    if (opts.fallbackDispatch === false) {
      return {
        ok: false,
        reason: 'mature_effect_not_found',
        landId: targetLandId,
        before,
        hasPlantComp: !!plantComp
      };
    }

    const fallback = await harvestSingleLand(targetLandId, opts);
    const rewardDismiss = await dismissRewardPopup({
      silent: true,
      waitAfter: opts.rewardWaitAfter == null ? 180 : opts.rewardWaitAfter,
    });
    return {
      ...fallback,
      action: 'click_mature_effect_fallback_dispatch',
      rewardDismiss
    };
  }

  function dispatchSingleLandPlant(seedId, landId) {
    const message = getOopsMessage();
    const payload = {
      land_id: landId,
      seed_id: seedId
    };
    message.dispatchEvent('REQUEST_CREATE_NEW_PLANT', payload);
    return payload;
  }

  function dispatchMultiLandPlant(seedId, landIds) {
    const message = getOopsMessage();
    const normalized = normalizeLandIds(landIds);
    const payload = {
      seed_id: seedId,
      land_id: normalized[0],
      mutiPlantData: normalized
    };
    message.dispatchEvent('REQUEST_CREATE_NEW_MULTI_LAND_PLANT', payload);
    return payload;
  }

  function plantSeedsOnLands(plantOrSeedId, landIds, opts) {
    if (!plantOrSeedId) throw new Error('plantOrSeedId required');
    const normalizedLandIds = normalizeLandIds(landIds);
    if (!Array.isArray(normalizedLandIds) || normalizedLandIds.length === 0) throw new Error('landIds required');

    if (opts && opts.useMultiLandPlant === true) {
      const payload = dispatchMultiLandPlant(plantOrSeedId, normalizedLandIds);
      return { planted: true, plantOrSeedId: plantOrSeedId, landCount: normalizedLandIds.length, payload: payload, mode: 'multi' };
    }

    const payloads = [];
    for (let i = 0; i < normalizedLandIds.length; i += 1) {
      payloads.push(dispatchSingleLandPlant(plantOrSeedId, normalizedLandIds[i]));
    }
    return { planted: true, plantOrSeedId: plantOrSeedId, landCount: normalizedLandIds.length, payloads: payloads, mode: 'single' };
  }

  async function plantSeedsOnLandsVerified(seedCandidates, landIds, opts) {
    const candidates = Array.isArray(seedCandidates) ? seedCandidates : [seedCandidates];
    const targetLandIds = Array.isArray(landIds) ? landIds.filter(function (id) {
      return Number.isFinite(Number(id)) && Number(id) > 0;
    }).map(function (id) { return Number(id); }) : [];
    if (targetLandIds.length === 0) throw new Error('landIds required');
    const attempts = [];
    const waitAfterPlantMs = Math.max(200, Number(opts && opts.waitAfterPlantMs) || 700);
    const beforeEmptyIds = getEmptyLandIds();

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = Number(candidates[i]) || 0;
      if (candidate <= 0) continue;
      let dispatchError = null;
      let plantResult = null;
      try {
        plantResult = plantSeedsOnLands(candidate, targetLandIds, opts);
      } catch (error) {
        dispatchError = error && error.message ? error.message : String(error);
      }
      await wait(waitAfterPlantMs);
      const afterEmptyIds = getEmptyLandIds();
      const plantedCount = beforeEmptyIds.filter(function (id) {
        return targetLandIds.indexOf(id) >= 0;
      }).length - afterEmptyIds.filter(function (id) {
        return targetLandIds.indexOf(id) >= 0;
      }).length;
      const attempt = {
        candidateSeedId: candidate,
        plantResult: plantResult,
        dispatchError: dispatchError,
        beforeEmptyIds: beforeEmptyIds,
        afterEmptyIds: afterEmptyIds,
        plantedCount: plantedCount,
        ok: !dispatchError && plantedCount > 0,
      };
      attempts.push(attempt);
      if (attempt.ok) {
        return {
          ok: true,
          candidateSeedId: candidate,
          plantedCount: plantedCount,
          attempts: attempts,
          beforeEmptyIds: beforeEmptyIds,
          afterEmptyIds: afterEmptyIds,
        };
      }
    }

    return {
      ok: false,
      reason: 'plant_verify_failed',
      attempts: attempts,
      beforeEmptyIds: beforeEmptyIds,
      afterEmptyIds: getEmptyLandIds(),
    };
  }

  /**
   * 自动种植 — 综合接口
   * opts.mode: 'backpack_first' | 'buy_highest' | 'buy_lowest' | 'none'
   * opts.emptyLandIds: 空地ID数组（不传则自动检测）
   */
  async function autoPlant(opts) {
    opts = opts || {};
    const mode = opts.mode || 'none';
    if (mode === 'none') return { ok: true, mode: mode, action: 'skip' };

    // 获取空地
    let emptyLandIds = opts.emptyLandIds;
    if (!Array.isArray(emptyLandIds) || emptyLandIds.length === 0) {
      const status = getFarmStatus({ includeGrids: true, includeLandIds: false, silent: true });
      if (!status || status.farmType !== 'own') {
        return { ok: false, mode: mode, reason: 'not_own_farm' };
      }
      emptyLandIds = [];
      const grids = Array.isArray(status.grids) ? status.grids : [];
      for (let i = 0; i < grids.length; i++) {
        const g = grids[i];
        if (g && g.stageKind === 'empty' && g.landId != null) {
          emptyLandIds.push(g.landId);
        }
      }
    }
    if (emptyLandIds.length === 0) {
      return { ok: true, mode: mode, action: 'no_empty_lands', emptyCount: 0 };
    }

    let plantId = Number(opts.plantId) || 0;
    let seedId = null;
    let seedName = null;
    let seedSource = null;

    if (opts.seedId) {
      seedId = Number(opts.seedId) || 0;
      seedName = resolveSeedDisplayName(seedId, opts.seedName) || 'unknown';
      const backpackCount = getBackpackSeedCount(seedId);
      const requiredCount = emptyLandIds.length;
      if (opts.shopGoodsId) {
        const buyCount = Math.max(0, requiredCount - backpackCount);
        const buyResult = await buyShopGoods(Number(opts.shopGoodsId), buyCount, Number(opts.shopPrice) || 0);
        if (buyCount > 0 && !buyResult.ok) {
          return { ok: false, mode: mode, reason: 'buy_failed', buyResult: buyResult };
        }
        seedSource = buyCount > 0 ? 'shop_explicit' : 'backpack_explicit';
      } else {
        let buyResult = null;
        if (backpackCount < requiredCount) {
          const shortage = Math.max(0, requiredCount - backpackCount);
          if (shortage > 0) {
            const desiredSeedName = resolveSeedDisplayName(seedId, opts.seedName);
            if (desiredSeedName) {
              buyResult = await buySeedsFromShopUi({
                seedName: desiredSeedName,
                seedId: seedId,
                count: shortage,
              });
            } else {
              return {
                ok: false,
                mode: mode,
                reason: backpackCount > 0 ? 'seed_shortage_and_name_missing' : 'seed_name_required',
                seedId: seedId,
                backpackCount: backpackCount,
                requiredCount: requiredCount,
              };
            }
          }
          if (shortage > 0 && (!buyResult || !buyResult.ok)) {
            return {
              ok: false,
              mode: mode,
              reason: 'buy_failed',
              buyResult: buyResult,
              seedName: seedName || null,
              seedId: seedId,
            };
          }
          seedSource = backpackCount > 0 ? 'backpack_plus_shop_lookup' : 'shop_lookup';
        } else {
          seedSource = 'backpack_explicit';
        }
      }
    } else if (mode === 'backpack_first') {
      // 优先使用背包中已有的种子（按等级降序选第一个有库存的）
      const seeds = getAllSeeds(3);
      const available = seeds.filter(function (s) { return s.count > 0; });
      if (available.length > 0) {
        seedId = available[0].id;
        seedName = available[0].name || 'unknown';
        seedSource = 'backpack';
      } else {
        return { ok: false, mode: mode, reason: 'no_seeds_in_backpack' };
      }
    } else if (mode === 'buy_highest' || mode === 'buy_lowest') {
      // 从商店购买种子
      const shopReady = await requestShopData(2);
      let shopSeeds;
      try {
        shopSeeds = getShopSeedList({ silent: true, sortByLevel: true });
      } catch (e) {
        return { ok: false, mode: mode, reason: 'shop_data_error', error: e.message };
      }
      if (!shopSeeds || shopSeeds.length === 0) {
        return { ok: false, mode: mode, reason: 'no_seeds_in_shop' };
      }
      const target = mode === 'buy_highest' ? shopSeeds[0] : shopSeeds[shopSeeds.length - 1];
      // 购买足够数量的种子
      const buyCount = emptyLandIds.length;
      const buyResult = await buyShopGoods(target.goodsId, buyCount, target.price);
      if (!buyResult.ok) {
        return { ok: false, mode: mode, reason: 'buy_failed', buyResult: buyResult, targetSeed: target };
      }
      seedId = target.itemId;
      seedName = target.name;
      seedSource = 'shop_' + mode;
    } else {
      return { ok: false, mode: mode, reason: 'unknown_mode' };
    }

    if (!seedId) {
      return { ok: false, mode: mode, reason: 'no_seed_resolved' };
    }

    const plantableSeed = resolvePlantableSeedItem(seedId);
    const dispatchSeedCandidates = [];
    const pushDispatchSeed = function (value) {
      const num = Number(value) || 0;
      if (num <= 0) return;
      if (dispatchSeedCandidates.indexOf(num) >= 0) return;
      dispatchSeedCandidates.push(num);
    };
    // 优先使用运行时可直接种植的 seedId/itemId，避免先尝试作物配置 id
    // 触发游戏内部“未找到作物配置”的错误提示。
    pushDispatchSeed(plantableSeed && plantableSeed.runtimeSeedId);
    pushDispatchSeed(plantableSeed && plantableSeed.itemId);
    pushDispatchSeed(seedId);
    pushDispatchSeed(plantId);

    // 种植
    const plantResult = await plantSeedsOnLandsVerified(dispatchSeedCandidates, emptyLandIds, opts);
    const rewardDismiss = await dismissRewardPopup({
      silent: true,
      waitAfter: opts && opts.rewardWaitAfter == null ? 180 : opts && opts.rewardWaitAfter,
    });
    return {
      ok: !!(plantResult && plantResult.ok),
      mode: mode,
      action: plantResult && plantResult.ok ? 'planted' : 'plant_failed',
      plantId: plantId || null,
      seedId: seedId,
      dispatchSeedId: plantResult && plantResult.candidateSeedId ? plantResult.candidateSeedId : dispatchSeedCandidates[0],
      dispatchSeedCandidates: dispatchSeedCandidates,
      seedName: seedName,
      seedSource: seedSource,
      plantableSeed: plantableSeed,
      emptyCount: emptyLandIds.length,
      plantResult: plantResult,
      rewardDismiss: rewardDismiss
    };
  }

  function openLandInteraction(pathOrNode) {
    const gridComp = getGridComponent(pathOrNode);

    if (typeof gridComp.handleValidLandClick === 'function') {
      return gridComp.handleValidLandClick();
    }
    if (typeof gridComp.triggerLandClick === 'function') {
      return gridComp.triggerLandClick();
    }
    if (typeof gridComp.onLandClick === 'function') {
      return gridComp.onLandClick();
    }
    if (typeof gridComp.dispatchLandClickEvent === 'function') {
      return gridComp.dispatchLandClickEvent();
    }

    throw new Error('No usable land interaction method on grid controller');
  }

  function getPlantInteractionRoot() {
    return findNode('startup/root/ui/LayerUI/plant_interactive_v2') || findNode('root/ui/LayerUI/plant_interactive_v2');
  }

  function findPlantInteractionManager() {
    const root = getPlantInteractionRoot();
    if (!root || !Array.isArray(root.components)) return null;
    for (let i = 0; i < root.components.length; i += 1) {
      const comp = root.components[i];
      if (comp && typeof comp.performFertilizing === 'function') {
        return comp;
      }
    }
    return null;
  }

  function findLandDetailComponent(root) {
    const interactionRoot = root || getPlantInteractionRoot();
    if (!interactionRoot) return null;
    const landDetailNode = walk(interactionRoot).find(function (node) {
      return !!(node && node.name === 'land_detail');
    });
    if (!landDetailNode || !Array.isArray(landDetailNode.components)) return null;
    for (let i = 0; i < landDetailNode.components.length; i += 1) {
      const comp = landDetailNode.components[i];
      if (comp && typeof comp.onSwitchBtnClick === 'function') {
        return comp;
      }
    }
    return null;
  }

  function findGridNodeByLandId(landId, root) {
    const targetLandId = normalizeLandId(landId);
    if (targetLandId == null) return null;
    const gridRoot = findGridOrigin(root);
    if (!gridRoot) return null;
    const nodes = getAllGridNodes(gridRoot);
    for (let i = 0; i < nodes.length; i += 1) {
      const gridComp = safeCall(function () { return getGridComponent(nodes[i]); }, null);
      if (!gridComp || typeof gridComp.getLandId !== 'function') continue;
      const currentLandId = normalizeLandId(safeCall(function () { return gridComp.getLandId(); }, null));
      if (currentLandId === targetLandId) return nodes[i];
    }
    return null;
  }

  async function openLandAndDiffButtons(pathOrNode, opts) {
    opts = opts || {};
    const waitAfter = opts.waitAfter == null ? 300 : Number(opts.waitAfter);
    const before = allButtons({ activeOnly: true });
    const beforeMap = new Map(before.map(item => [item.path, JSON.stringify(item)]));
    const ret = openLandInteraction(pathOrNode);
    await wait(waitAfter);
    const after = allButtons({ activeOnly: true });

    const added = after.filter(item => !beforeMap.has(item.path));
    const changed = after.filter(item => beforeMap.has(item.path) && beforeMap.get(item.path) !== JSON.stringify(item));

    return out({
      action: 'openLandAndDiffButtons',
      path: typeof pathOrNode === 'string' ? pathOrNode : fullPath(pathOrNode),
      ret,
      added,
      changed,
      afterCount: after.length
    });
  }

  async function inspectLandDetail(opts) {
    opts = opts || {};
    const root = findGridOrigin(opts.root || opts.path);
    if (!root) throw new Error('GridOrigin not found');

    let targetNode = null;
    if (opts.path) {
      targetNode = toNode(opts.path);
    }
    if (!targetNode && opts.landId != null) {
      targetNode = findGridNodeByLandId(opts.landId, root);
    }
    if (!targetNode) {
      const nodes = getAllGridNodes(root);
      targetNode = nodes.length > 0 ? nodes[0] : null;
    }
    if (!targetNode) throw new Error('No target land found for land detail inspection');

    const waitAfter = opts.waitAfter == null ? 280 : Math.max(0, Number(opts.waitAfter) || 0);
    const ret = openLandInteraction(targetNode);
    if (waitAfter > 0) await wait(waitAfter);

    const interactionRoot = getPlantInteractionRoot();
    const interactionManager = findPlantInteractionManager();
    const landDetailComp = findLandDetailComponent(interactionRoot);
    const currentDetailComp = safeReadKey(interactionManager, 'currentDetailComp');
    const gridState = safeCall(function () {
      return getGridState(targetNode, { silent: true, farmType: 'own' });
    }, null);
    const targetLandId = gridState && gridState.landId != null
      ? normalizeLandId(gridState.landId)
      : normalizeLandId(opts.landId);
    if (landDetailComp && targetLandId != null) {
      safeCall(function () {
        landDetailComp.landId = targetLandId;
        return true;
      }, null);
      safeCall(function () {
        if (typeof landDetailComp.onLandChanged === 'function') return landDetailComp.onLandChanged();
        return null;
      }, null);
      safeCall(function () {
        if (typeof landDetailComp.updateLandLabel === 'function') return landDetailComp.updateLandLabel();
        return null;
      }, null);
      safeCall(function () {
        if (typeof landDetailComp.updateBenefitDisplay === 'function') return landDetailComp.updateBenefitDisplay();
        return null;
      }, null);
      safeCall(function () {
        if (typeof landDetailComp.updateLandSprite === 'function') return landDetailComp.updateLandSprite();
        return null;
      }, null);
      if (waitAfter > 0) await wait(Math.min(waitAfter, 120));
    }
    if (landDetailComp) {
      if (typeof landDetailComp.onLandNodeClick === 'function') {
        safeCall(function () { return landDetailComp.onLandNodeClick(); }, null);
        if (waitAfter > 0) await wait(Math.min(waitAfter, 180));
      }
      if (safeReadKey(landDetailComp, 'detailType') !== 'land' && typeof landDetailComp.onSwitchBtnClick === 'function') {
        safeCall(function () { return landDetailComp.onSwitchBtnClick(); }, null);
        if (waitAfter > 0) await wait(Math.min(waitAfter, 180));
      }
    }
    const detailNode =
      safeReadKey(interactionManager, 'detailInteractionNode') ||
      (interactionRoot
        ? walk(interactionRoot).find(function (node) { return !!(node && node.name === 'land_detail' && node.activeInHierarchy); }) || null
        : null);
    const landLabelNode = landDetailComp ? safeReadKey(landDetailComp, 'landLabel') : null;
    const levelTipNode = landDetailComp ? safeReadKey(landDetailComp, 'levelIconTipLabel') : null;
    const benefitNodes = landDetailComp && Array.isArray(safeReadKey(landDetailComp, 'benefitNodes'))
      ? safeReadKey(landDetailComp, 'benefitNodes')
      : [];
    const detailTexts = detailNode ? getNodeTextList(detailNode, { maxDepth: 8 }).slice(0, 100) : [];
    const labelTexts = collectNodeTexts(landLabelNode, 3, 20);
    const levelTipTexts = collectNodeTexts(levelTipNode, 3, 20);
    const benefitTexts = []
      .concat.apply([], benefitNodes.slice(0, 8).map(function (node) {
        return collectNodeTexts(node, 2, 10);
      }))
      .slice(0, 50);
    const rootTexts = interactionRoot ? getNodeTextList(interactionRoot, { maxDepth: 6 }).slice(0, 150) : [];
    const landRuntime = safeCall(function () {
      const gridComp = getGridComponent(targetNode);
      return getLandRuntime(gridComp);
    }, null);
    const runtimeLandType = pickLandTypeFromRuntime(landRuntime) || pickLandTypeFromRuntime(currentDetailComp) || pickLandTypeFromRuntime(landDetailComp);
    const resolvedLandType =
      detectLandTypeFromTexts(labelTexts) ||
      detectLandTypeFromTexts(levelTipTexts) ||
      detectLandTypeFromTexts(benefitTexts) ||
      detectLandTypeFromTexts(detailTexts) ||
      detectLandTypeFromTexts(rootTexts) ||
      runtimeLandType;
    return opts.silent ? {
      action: 'inspectLandDetail',
      ret: summarizeSpyValue(ret, 1),
      landId: targetLandId,
      path: fullPath(targetNode),
      detailNodePath: detailNode ? fullPath(detailNode) : null,
      currentDetailType: safeReadKey(interactionManager, 'currentDetailType'),
      detailType: landDetailComp ? safeReadKey(landDetailComp, 'detailType') : null,
      detailLandId: landDetailComp ? safeReadKey(landDetailComp, 'landId') : null,
      detailComp: summarizeRuntimeObject(currentDetailComp, 'currentDetailComp'),
      landDetailComp: summarizeRuntimeObject(landDetailComp, 'landDetailComp'),
      landRuntime: summarizeRuntimeObject(landRuntime, 'landRuntime'),
      landLabelTexts: labelTexts,
      levelTipTexts: levelTipTexts,
      benefitTexts: benefitTexts,
      detailTexts: detailTexts,
      rootTexts: rootTexts,
      runtimeLandType: runtimeLandType,
      resolvedLandType: resolvedLandType,
      landTypeResolved: !!resolvedLandType
    } : out({
      action: 'inspectLandDetail',
      ret: summarizeSpyValue(ret, 1),
      landId: targetLandId,
      path: fullPath(targetNode),
      detailNodePath: detailNode ? fullPath(detailNode) : null,
      currentDetailType: safeReadKey(interactionManager, 'currentDetailType'),
      detailType: landDetailComp ? safeReadKey(landDetailComp, 'detailType') : null,
      detailLandId: landDetailComp ? safeReadKey(landDetailComp, 'landId') : null,
      detailComp: summarizeRuntimeObject(currentDetailComp, 'currentDetailComp'),
      landDetailComp: summarizeRuntimeObject(landDetailComp, 'landDetailComp'),
      landRuntime: summarizeRuntimeObject(landRuntime, 'landRuntime'),
      landLabelTexts: labelTexts,
      levelTipTexts: levelTipTexts,
      benefitTexts: benefitTexts,
      detailTexts: detailTexts,
      rootTexts: rootTexts,
      runtimeLandType: runtimeLandType,
      resolvedLandType: resolvedLandType,
      landTypeResolved: !!resolvedLandType
    });
  }

  async function inspectFertilizerRuntime(opts) {
    opts = opts || {};
    const root = findGridOrigin(opts.root || opts.path);
    if (!root) throw new Error('GridOrigin not found');

    let targetNode = null;
    if (opts.path) {
      targetNode = toNode(opts.path);
    }
    if (!targetNode && opts.landId != null) {
      targetNode = findGridNodeByLandId(opts.landId, root);
    }
    if (!targetNode) {
      const nodes = getAllGridNodes(root);
      for (let i = 0; i < nodes.length; i += 1) {
        const info = safeCall(function () {
          return getGridState(nodes[i], { silent: true, farmType: 'own' });
        }, null);
        if (info && (info.hasPlant || info.landId != null)) {
          targetNode = nodes[i];
          break;
        }
      }
    }
    if (!targetNode) throw new Error('No target land found for fertilizer inspection');

    const gridComp = getGridComponent(targetNode);
    const landRuntime = getLandRuntime(gridComp);
    const plantRuntime = getPlantRuntime(gridComp);
    const gridState = getGridState(targetNode, { silent: true, farmType: 'own' });
    const itemM = safeCall(function () { return getItemManager(); }, null);
    const normalContainer = itemM ? safeReadKey(itemM, 'normalFertilizerContainer') : null;
    const organicContainer = itemM ? safeReadKey(itemM, 'organicFertilizerContainer') : null;
    const allFertilizer = itemM && typeof itemM.getAllFertilizer === 'function'
      ? safeCall(function () { return itemM.getAllFertilizer(); }, null)
      : null;
    const fertilizerItems = itemM && typeof itemM.getFertilizer_items === 'function'
      ? safeCall(function () { return itemM.getFertilizer_items(); }, null)
      : null;
    const fertilizerBuckets = itemM && typeof itemM.getFertilizer_bucket === 'function'
      ? safeCall(function () { return itemM.getFertilizer_bucket(); }, null)
      : null;

    const keywordMethods = {
      grid: filterMethodNamesByKeywords(gridComp, ['fert', 'item', 'plant', 'land', 'click', 'use']),
      landRuntime: filterMethodNamesByKeywords(landRuntime, ['fert', 'water', 'plant', 'land', 'time', 'season']),
      plantRuntime: filterMethodNamesByKeywords(plantRuntime, ['fert', 'water', 'plant', 'time', 'season', 'fruit']),
      itemManager: filterMethodNamesByKeywords(itemM, ['fert', 'item', 'count', 'update', 'normal', 'organic']),
      normalContainer: filterMethodNamesByKeywords(normalContainer, ['fert', 'time', 'remain', 'use', 'add', 'fill']),
      organicContainer: filterMethodNamesByKeywords(organicContainer, ['fert', 'time', 'remain', 'use', 'add', 'fill'])
    };

    const directState = {
      hasNormalFertilizer: itemM && typeof itemM.hasNormalFertilizer === 'function'
        ? !!safeCall(function () { return itemM.hasNormalFertilizer(); }, false)
        : null,
      hasOrganicFertilizer: itemM && typeof itemM.hasOrganicFertilizer === 'function'
        ? !!safeCall(function () { return itemM.hasOrganicFertilizer(); }, false)
        : null,
      canFertilize: plantRuntime && typeof plantRuntime.canFertilize === 'function'
        ? !!safeCall(function () { return plantRuntime.canFertilize(); }, false)
        : null,
      normalRemainingTime: itemM && typeof itemM.getNormalFertilizerRemainingTime === 'function'
        ? safeCall(function () { return toFiniteNumber(itemM.getNormalFertilizerRemainingTime()); }, null)
        : null,
      organicRemainingTime: itemM && typeof itemM.getOrganicFertilizerRemainingTime === 'function'
        ? safeCall(function () { return toFiniteNumber(itemM.getOrganicFertilizerRemainingTime()); }, null)
        : null,
      normalFertilizer: itemM && typeof itemM.getNormalFertilizer === 'function'
        ? safeCall(function () { return itemM.getNormalFertilizer(); }, null)
        : null,
      organicFertilizer: itemM && typeof itemM.getOrganicFertilizer === 'function'
        ? safeCall(function () { return itemM.getOrganicFertilizer(); }, null)
        : null,
    };
    const normalDetailItem = findBestFertilizerDetailItem(itemM, 'normal');
    const organicDetailItem = findBestFertilizerDetailItem(itemM, 'organic');

    const buttonDiff = await openLandAndDiffButtons(targetNode, {
      waitAfter: opts.waitAfter == null ? 350 : opts.waitAfter
    });
    const buttonKeywords = ['肥', '化肥', '有机', '普通', 'fert', 'organic', 'normal'];
    const fertilizerButtons = []
      .concat(Array.isArray(buttonDiff && buttonDiff.added) ? buttonDiff.added : [])
      .concat(Array.isArray(buttonDiff && buttonDiff.changed) ? buttonDiff.changed : [])
      .filter(function (item) {
        const texts = []
          .concat(Array.isArray(item && item.texts) ? item.texts : [])
          .concat(Array.isArray(item && item.handlers) ? item.handlers : [])
          .concat([item && item.path, item && item.relativePath, item && item.name]);
        const joined = texts.filter(Boolean).join(' ').toLowerCase();
        return buttonKeywords.some(function (keyword) {
          return joined.indexOf(String(keyword).toLowerCase()) >= 0;
        });
      });

    function summarizeNodeComponents(node) {
      if (!node || !Array.isArray(node.components)) return [];
      return node.components.slice(0, 8).map(function (comp, index) {
        if (!comp) return { index: index, exists: false };
        return {
          index: index,
          name: comp && comp.constructor ? comp.constructor.name : String(comp),
          summary: summarizeRuntimeObject(comp, 'component'),
          methods: filterMethodNamesByKeywords(comp, ['fert', 'seed', 'plant', 'land', 'switch', 'erase', 'use', 'click', 'show', 'open']),
        };
      });
    }

    const interactionRoot = getPlantInteractionRoot();
    const interactionManager = findPlantInteractionManager();
    const interactionNodes = interactionRoot
      ? walk(interactionRoot)
          .filter(function (node) { return !!(node && node.activeInHierarchy); })
          .map(function (node) {
            const texts = getNodeTextList(node, { maxDepth: 2 }).slice(0, 8);
            const components = componentNames(node);
            const componentDetails = summarizeNodeComponents(node);
            const path = fullPath(node);
            const joined = [path, node.name]
              .concat(texts)
              .concat(components)
              .join(' ')
              .toLowerCase();
            const hasButtonLikeComponent = componentDetails.some(function (detail) {
              const keys = safeReadKey(detail, 'summary') && Array.isArray(detail.summary.keys)
                ? detail.summary.keys
                : [];
              return keys.indexOf('clickEvents') >= 0;
            });
            const isRelevant = hasButtonLikeComponent ||
              texts.length > 0 ||
              /tool|seed|detail|fert|bucket|switch|erase|node1|node2|group|btn|button/.test(joined);
            return {
              path: path,
              name: node.name || null,
              components: components,
              texts: texts,
              componentDetails: componentDetails,
              hasButtonLikeComponent: hasButtonLikeComponent,
              isRelevant: isRelevant,
            };
          })
          .filter(function (node) { return node.isRelevant; })
          .slice(0, 160)
      : [];

    function snapshotFertilizerDetailState(manager, landDetailComp) {
      const detailComp = safeReadKey(manager, 'currentDetailComp');
      const detailNode = safeReadKey(manager, 'detailInteractionNode');
      return {
        canFertilize: typeof manager.canFertilize === 'function'
          ? !!safeCall(function () { return manager.canFertilize(); }, false)
          : null,
        currentDetailType: safeReadKey(manager, 'currentDetailType'),
        currentData: summarizeSpyValue(safeReadKey(manager, 'currentData'), 1),
        currentDetailComp: summarizeRuntimeObject(detailComp, 'currentDetailComp'),
        currentDetailCompMethods: filterMethodNamesByKeywords(
          detailComp,
          ['fert', 'detail', 'item', 'use', 'confirm', 'click', 'select', 'organic', 'normal']
        ),
        landDetail: landDetailComp ? {
          detailType: safeReadKey(landDetailComp, 'detailType'),
          landId: safeReadKey(landDetailComp, 'landId'),
          methods: filterMethodNamesByKeywords(landDetailComp, ['switch', 'detail', 'tip', 'plant', 'seed', 'land']),
        } : null,
        detailNode: summarizeRuntimeObject(detailNode, 'detailInteractionNode'),
        detailTexts: detailNode ? getNodeTextList(detailNode, { maxDepth: 3 }).slice(0, 20) : [],
      };
    }

    async function probeFertilizerDetail(manager, itemM, item, modeLabel, landDetailComp) {
      if (!manager || typeof manager.showDetailForItem !== 'function' || !item) {
        return {
          mode: modeLabel,
          attempted: false,
          reason: !item ? 'item_missing' : 'showDetailForItem_missing',
        };
      }
      const candidates = buildFertilizerDetailCandidates(itemM, item);
      const attempts = [];
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const beforeState = snapshotFertilizerDetailState(manager, landDetailComp);
        const ret = safeCall(function () { return manager.showDetailForItem(candidate.value); }, null);
        await wait(120);
        const afterState = snapshotFertilizerDetailState(manager, landDetailComp);
        attempts.push({
          label: candidate.label,
          candidate: summarizeSpyValue(candidate.value, 1),
          ret: summarizeSpyValue(ret, 1),
          before: beforeState,
          after: afterState,
        });
        safeCall(function () {
          if (typeof manager.commonClose === 'function') return manager.commonClose();
          return null;
        }, null);
        await wait(60);
      }
      return {
        mode: modeLabel,
        attempted: true,
        item: summarizeSpyValue(item, 1),
        attempts: attempts,
      };
    }

    async function probeLandDetailSwitch(manager, landDetailComp, item) {
      if (!manager || !landDetailComp || typeof landDetailComp.onSwitchBtnClick !== 'function') {
        return {
          attempted: false,
          reason: !landDetailComp ? 'land_detail_missing' : 'switch_not_found',
        };
      }
      const before = snapshotFertilizerDetailState(manager, landDetailComp);
      safeCall(function () { return landDetailComp.onSwitchBtnClick(); }, null);
      await wait(120);
      const afterSwitch = snapshotFertilizerDetailState(manager, landDetailComp);
      let afterShowItem = null;
      if (item && typeof manager.showDetailForItem === 'function') {
        safeCall(function () { return manager.showDetailForItem(item); }, null);
        await wait(120);
        afterShowItem = snapshotFertilizerDetailState(manager, landDetailComp);
      }
      safeCall(function () {
        if (typeof manager.commonClose === 'function') return manager.commonClose();
        return null;
      }, null);
      await wait(60);
      return {
        attempted: true,
        before: before,
        afterSwitch: afterSwitch,
        afterShowItem: afterShowItem,
      };
    }

    const landDetailComp = findLandDetailComponent(interactionRoot);
    const detailProbe = interactionManager ? {
      normal: await probeFertilizerDetail(interactionManager, itemM, normalDetailItem, 'normal', landDetailComp),
      organic: await probeFertilizerDetail(interactionManager, itemM, organicDetailItem, 'organic', landDetailComp),
    } : null;
    const switchProbe = interactionManager
      ? await probeLandDetailSwitch(interactionManager, landDetailComp, directState.normalFertilizer)
      : null;

    const payload = {
      target: {
        landId: gridState.landId,
        path: gridState.path,
        plantName: gridState.plantName,
        landType: gridState.landType,
        stageKind: gridState.stageKind,
        currentSeason: gridState.currentSeason,
        totalSeason: gridState.totalSeason,
        matureInSec: gridState.matureInSec,
      },
      itemCounts: {
        coupon1002: getItemCountById(1002),
        bean1005: getItemCountById(1005),
      },
      directState: directState,
      detailItems: {
        normal: summarizeInventoryEntry(normalDetailItem),
        organic: summarizeInventoryEntry(organicDetailItem),
      },
      allFertilizer: Array.isArray(allFertilizer)
        ? allFertilizer.slice(0, 20).map(function (item) {
            return summarizeSpyValue(item, 1);
          })
        : allFertilizer,
      fertilizerItems: summarizeInventoryArray(fertilizerItems, 12),
      fertilizerBuckets: summarizeInventoryArray(fertilizerBuckets, 12),
      runtime: {
        grid: summarizeRuntimeObject(gridComp, 'grid'),
        landRuntime: summarizeRuntimeObject(landRuntime, 'landRuntime'),
        plantRuntime: summarizeRuntimeObject(plantRuntime, 'plantRuntime'),
        itemManager: summarizeRuntimeObject(itemM, 'itemManager'),
        normalContainer: summarizeRuntimeObject(normalContainer, 'normalFertilizerContainer'),
        organicContainer: summarizeRuntimeObject(organicContainer, 'organicFertilizerContainer'),
        interactionManager: summarizeRuntimeObject(interactionManager, 'interactionManager'),
      },
      methodSourcePreview: {
        interactionManager: interactionManager ? {
          performFertilizing: getMethodSourcePreview(interactionManager, 'performFertilizing', 1400),
          attemptPerform: getMethodSourcePreview(interactionManager, 'attemptPerform', 1400),
          canFertilize: getMethodSourcePreview(interactionManager, 'canFertilize', 1200),
          checkState: getMethodSourcePreview(interactionManager, 'checkState', 1200),
          setCurrentData: getMethodSourcePreview(interactionManager, 'setCurrentData', 1400),
          getToolNode: getMethodSourcePreview(interactionManager, 'getToolNode', 1200),
          onToolInteractionNodeTouchStart: getMethodSourcePreview(interactionManager, 'onToolInteractionNodeTouchStart', 1400),
          showDetailForItem: getMethodSourcePreview(interactionManager, 'showDetailForItem', 1400),
          getOrCreateDetailComp: getMethodSourcePreview(interactionManager, 'getOrCreateDetailComp', 1400),
          selectAppropriateInteractionNode: getMethodSourcePreview(interactionManager, 'selectAppropriateInteractionNode', 1400),
          onToolInteractionNodeTouchEnd: getMethodSourcePreview(interactionManager, 'onToolInteractionNodeTouchEnd', 1400),
          onInteractionNodeTouchStart: getMethodSourcePreview(interactionManager, 'onInteractionNodeTouchStart', 1400),
          onInteractionNodeTouchEnd: getMethodSourcePreview(interactionManager, 'onInteractionNodeTouchEnd', 1400),
          startDrag: getMethodSourcePreview(interactionManager, 'startDrag', 1400),
          endDrag: getMethodSourcePreview(interactionManager, 'endDrag', 1200),
          attemptLandInteraction: getMethodSourcePreview(interactionManager, 'attemptLandInteraction', 1400),
        } : null,
        landDetail: landDetailComp ? {
          onSwitchBtnClick: getMethodSourcePreview(landDetailComp, 'onSwitchBtnClick', 1000),
          showPlantDetail: getMethodSourcePreview(landDetailComp, 'showPlantDetail', 1200),
          onLandNodeClick: getMethodSourcePreview(landDetailComp, 'onLandNodeClick', 1200),
        } : null,
      },
      interactionManagerState: interactionManager ? {
        canFertilize: typeof interactionManager.canFertilize === 'function'
          ? !!safeCall(function () { return interactionManager.canFertilize(); }, false)
          : null,
        currentDetailType: safeReadKey(interactionManager, 'currentDetailType'),
        currentData: summarizeSpyValue(safeReadKey(interactionManager, 'currentData'), 1),
        currentDataState: summarizeCurrentDataState(interactionManager),
        currentDataItems: summarizeInventoryArray(safeReadKey(interactionManager, 'currentData'), 10),
        currentToolNodeInfo: summarizeSpyValue(safeReadKey(interactionManager, 'currentToolNodeInfo'), 1),
        currentSeedNodeInfo: summarizeSpyValue(safeReadKey(interactionManager, 'currentSeedNodeInfo'), 1),
        currentDetailComp: summarizeRuntimeObject(safeReadKey(interactionManager, 'currentDetailComp'), 'currentDetailComp'),
        toolInteractionNode: summarizeRuntimeObject(safeReadKey(interactionManager, 'toolInteractionNode'), 'toolInteractionNode'),
        seedInteractionNode: summarizeRuntimeObject(safeReadKey(interactionManager, 'seedInteractionNode'), 'seedInteractionNode'),
        detailInteractionNode: summarizeRuntimeObject(safeReadKey(interactionManager, 'detailInteractionNode'), 'detailInteractionNode'),
        fertilizeDetailPrefab: summarizeSpyValue(safeReadKey(interactionManager, 'fertilizeDetailPrefab'), 1),
        toolNodeLookup: {
          normalBucket1011: summarizeNodeForClick(getToolNodeByItemId(interactionManager, 1011)),
          organicBucket1012: summarizeNodeForClick(getToolNodeByItemId(interactionManager, 1012)),
          water10007: summarizeNodeForClick(getToolNodeByItemId(interactionManager, 10007)),
        },
        methodArities: {
          performFertilizing: typeof interactionManager.performFertilizing === 'function' ? interactionManager.performFertilizing.length : null,
          showDetailForItem: typeof interactionManager.showDetailForItem === 'function' ? interactionManager.showDetailForItem.length : null,
          attemptLandInteraction: typeof interactionManager.attemptLandInteraction === 'function' ? interactionManager.attemptLandInteraction.length : null,
          setupPlantInteraction: typeof interactionManager.setupPlantInteraction === 'function' ? interactionManager.setupPlantInteraction.length : null,
          setCurrentData: typeof interactionManager.setCurrentData === 'function' ? interactionManager.setCurrentData.length : null,
        }
      } : null,
      detailProbe: detailProbe,
      switchProbe: switchProbe,
      keywordMethods: keywordMethods,
      buttonDiff: buttonDiff,
      fertilizerButtons: fertilizerButtons,
      interactionNodes: interactionNodes,
    };

    return opts.silent ? payload : out(payload);
  }

  function inspectProtocolTransport(opts) {
    opts = opts || {};
    installRuntimeSpies();
    const net = safeCall(function () { return getNetWebSocket(); }, null);
    const message = safeCall(function () { return getOopsMessage(); }, null);
    const protobufRoot = safeCall(function () { return getProtobufDefault(); }, null);
    const channels = net ? safeReadKey(net, '_channels') : null;
    const primaryChannel = channels && typeof channels.get === 'function'
      ? safeCall(function () { return channels.get(0); }, null)
      : null;
    const serviceMap = primaryChannel ? safeReadKey(primaryChannel, '_serviceInstaceMap') : null;
    const nestedGamePb = protobufRoot ? findNestedValueByKey(protobufRoot, 'gamepb', 5) : null;
    const channelEntries = channels && typeof channels.forEach === 'function'
      ? safeCall(function () {
          const entries = [];
          channels.forEach(function (value, key) {
            if (entries.length >= 8) return;
            entries.push({
              key: key,
              value: summarizeRuntimeObject(value, 'channel'),
              methods: filterMethodNamesByKeywords(value, ['send', 'req', 'msg', 'rpc', 'call', 'proto']),
            });
          });
          return entries;
        }, [])
      : [];

    const payload = {
      netWebSocket: summarizeRuntimeObject(net, 'netWebSocket'),
      messageBus: summarizeRuntimeObject(message, 'messageBus'),
      protobufRoot: summarizeRuntimeObject(protobufRoot, 'protobufDefault'),
      methodSourcePreview: {
        netWebSocket: net ? {
          sendMsg: getMethodSourcePreview(net, 'sendMsg', 1600),
          onFrame: getMethodSourcePreview(net, 'onFrame', 1200),
          connect: getMethodSourcePreview(net, 'connect', 1000),
          connectSvr: getMethodSourcePreview(net, 'connectSvr', 1000),
        } : null,
        channel: primaryChannel ? {
          send: getMethodSourcePreview(primaryChannel, 'send', 2000),
          getService: getMethodSourcePreview(primaryChannel, 'getService', 1600),
          onMessage: getMethodSourcePreview(primaryChannel, 'onMessage', 1600),
          getServiceFunName: getMethodSourcePreview(primaryChannel, 'getServiceFunName', 1200),
        } : null,
        messageBus: message ? {
          dispatchEvent: getMethodSourcePreview(message, 'dispatchEvent', 1200),
          on: getMethodSourcePreview(message, 'on', 800),
          off: getMethodSourcePreview(message, 'off', 800),
        } : null,
      },
      netChannels: {
        count: channels && typeof channels.size === 'number' ? channels.size : null,
        entries: channelEntries,
      },
      primaryChannel: summarizeRuntimeObject(primaryChannel, 'primaryChannel'),
      serviceInstanceMap: {
        count: serviceMap && typeof serviceMap.size === 'number' ? serviceMap.size : null,
        entries: summarizeMapEntries(serviceMap, 16),
      },
      nestedGamePb: nestedGamePb ? {
        path: nestedGamePb.path,
        summary: summarizeRuntimeObject(nestedGamePb.value, 'nestedGamePb'),
      } : null,
      protobufRefs: {
        plantService: summarizeProtobufRef('gamepb.plantpb.PlantService'),
        fertilizeRequest: summarizeProtobufRef('gamepb.plantpb.FertilizeRequest'),
        fertilizeReply: summarizeProtobufRef('gamepb.plantpb.FertilizeReply'),
        allLandsRequest: summarizeProtobufRef('gamepb.plantpb.AllLandsRequest'),
        allLandsReply: summarizeProtobufRef('gamepb.plantpb.AllLandsReply'),
      },
      recentRuntimeEvents: {
        messageEvents: Array.isArray(runtimeSpyState.messageEvents)
          ? runtimeSpyState.messageEvents.slice(-12)
          : [],
        frameEvents: Array.isArray(runtimeSpyState.frameEvents)
          ? runtimeSpyState.frameEvents.slice(-8)
          : [],
      },
    };

    return opts.silent ? payload : out(payload);
  }

  function inspectRecentClickTrace(opts) {
    opts = opts || {};
    installRuntimeSpies();
    installInteractionManagerSpies();
    const limit = Math.max(1, Math.min(40, Number(opts.limit) || 20));
    const payload = {
      installed: !!runtimeSpyState.installed,
      lastInstallAt: runtimeSpyState.lastInstallAt,
      count: Array.isArray(runtimeSpyState.clickEvents) ? runtimeSpyState.clickEvents.length : 0,
      recent: Array.isArray(runtimeSpyState.clickEvents)
        ? runtimeSpyState.clickEvents.slice(-limit)
        : [],
      interactionMethodCount: Array.isArray(runtimeSpyState.interactionMethodEvents)
        ? runtimeSpyState.interactionMethodEvents.length
        : 0,
      interactionMethods: Array.isArray(runtimeSpyState.interactionMethodEvents)
        ? runtimeSpyState.interactionMethodEvents.slice(-limit)
        : [],
    };
    return opts.silent ? payload : out(payload);
  }

  function findFertilizerActionNode(mode, manager, selectedBucket) {
    const modeName = String(mode || '').toLowerCase();
    const directToolNode = getToolNodeByItemId(manager, selectedBucket && selectedBucket.id);
    if (directToolNode) return directToolNode;
    const toolRoot = manager ? safeReadKey(manager, 'toolInteractionNode') : null;
    if (toolRoot) {
      const toolNodes = walk(toolRoot)
        .map(function (node) {
          return {
            node: node,
            path: fullPath(node),
            texts: getNodeTextList(node, { maxDepth: 2 }).slice(0, 4),
          };
        })
        .filter(function (entry) {
          return entry.node && entry.texts.some(function (text) { return /小时/.test(String(text)); });
        });
      if (toolNodes.length >= 2) {
        toolNodes.sort(function (a, b) {
          const ta = (a.texts[0] || '');
          const tb = (b.texts[0] || '');
          const na = parseFloat(String(ta).replace(/[^\d.]/g, ''));
          const nb = parseFloat(String(tb).replace(/[^\d.]/g, ''));
          return (nb || 0) - (na || 0);
        });
        return modeName === 'organic' ? toolNodes[1].node : toolNodes[0].node;
      }
    }
    const toolInfo = manager ? safeReadKey(manager, 'currentToolNodeInfo') : null;
    const subNodes = toolInfo && Array.isArray(safeReadKey(toolInfo, 'subNodes'))
      ? safeReadKey(toolInfo, 'subNodes')
      : null;
    if (Array.isArray(subNodes) && subNodes.length > 0) {
      const withText = subNodes
        .map(function (node) {
          return {
            node: node,
            path: fullPath(node),
            texts: getNodeTextList(node, { maxDepth: 2 }).slice(0, 4),
          };
        })
        .filter(function (entry) {
          return entry.node && entry.texts.some(function (text) { return /小时/.test(String(text)); });
        });
      if (withText.length >= 2) {
        withText.sort(function (a, b) {
          const ta = (a.texts[0] || '');
          const tb = (b.texts[0] || '');
          const na = parseFloat(String(ta).replace(/[^\d.]/g, ''));
          const nb = parseFloat(String(tb).replace(/[^\d.]/g, ''));
          return (nb || 0) - (na || 0);
        });
        return modeName === 'organic' ? withText[1].node : withText[0].node;
      }
    }

    const interactionRoot = getPlantInteractionRoot();
    if (!interactionRoot) return null;
    const fallbackNames = modeName === 'organic'
      ? ['node3', 'node2']
      : ['node2', 'node1'];
    const nodes = walk(interactionRoot).filter(function (node) {
      return !!(node && node.activeInHierarchy);
    });
    for (let i = 0; i < fallbackNames.length; i += 1) {
      const targetName = fallbackNames[i];
      const preferredPathPart = '/followNode/seedGroup/group_5/' + targetName;
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j];
        const path = fullPath(node);
        if (path && path.indexOf(preferredPathPart) >= 0) return node;
      }
    }
    return null;
  }

  function primeFertilizerToolNodes(manager, selectedBucket, targetArg) {
    if (!manager) return;
    if (typeof manager.selectAppropriateInteractionNode === 'function') {
      safeCall(function () { return manager.selectAppropriateInteractionNode(); }, null);
    }
    const toolNode = safeReadKey(manager, 'toolInteractionNode');
    if (toolNode) {
      safeCall(function () { toolNode.active = true; }, null);
      safeCall(function () { toolNode._active = true; }, null);
    }
    const seedNode = safeReadKey(manager, 'seedInteractionNode');
    if (seedNode) {
      safeCall(function () { seedNode.active = true; }, null);
      safeCall(function () { seedNode._active = true; }, null);
    }
  }

  async function ensureFertilizerActionPanel(manager) {
    const interactionRoot = getPlantInteractionRoot();
    if (!interactionRoot) return false;

    function hasSeedGroupActionNodes() {
      return !!findFertilizerActionNode('normal') || !!findFertilizerActionNode('organic');
    }

    if (hasSeedGroupActionNodes()) return true;

    const landDetailComp = findLandDetailComponent(interactionRoot);
    if (landDetailComp && typeof landDetailComp.onSwitchBtnClick === 'function') {
      safeCall(function () { return landDetailComp.onSwitchBtnClick(); }, null);
      await wait(180);
      if (hasSeedGroupActionNodes()) return true;
    }

    const switchNode = findNode('startup/root/ui/LayerUI/plant_interactive_v2/land_detail/switch');
    if (switchNode) {
      safeCall(function () { tapNode(switchNode); }, null);
      await wait(220);
      if (hasSeedGroupActionNodes()) return true;
    }

    if (manager && typeof manager.selectAppropriateInteractionNode === 'function') {
      safeCall(function () { return manager.selectAppropriateInteractionNode(); }, null);
      await wait(180);
      if (hasSeedGroupActionNodes()) return true;
    }

    return hasSeedGroupActionNodes();
  }

  async function fertilizeLand(opts) {
    opts = opts || {};
    const rawMode = String(opts.type || opts.mode || 'auto').trim().toLowerCase();
    const mode = rawMode === 'inorganic' ? 'normal' : rawMode;
    const dryRun = opts.dryRun !== false;
    const useInternalFallback = opts.internalFallback === true;
    const waitAfterOpen = Math.max(100, Number(opts.waitAfterOpen) || 350);
    const waitAfterAction = Math.max(100, Number(opts.waitAfterAction) || 500);

    let targetNode = null;
    if (opts.path) targetNode = toNode(opts.path);
    if (!targetNode && opts.landId != null) {
      targetNode = findGridNodeByLandId(opts.landId);
    }
    if (!targetNode) throw new Error('Target land not found');

    const ownership = getFarmOwnership({ silent: true, allowWeakUi: true });
    if (ownership && ownership.farmType && ownership.farmType !== 'own') {
      throw new Error('fertilize only supported in own farm');
    }

    const before = getGridState(targetNode, { silent: true, farmType: 'own' });
    const itemM = getItemManager();
    const hasNormal = typeof itemM.hasNormalFertilizer === 'function'
      ? !!safeCall(function () { return itemM.hasNormalFertilizer(); }, false)
      : false;
    const hasOrganic = typeof itemM.hasOrganicFertilizer === 'function'
      ? !!safeCall(function () { return itemM.hasOrganicFertilizer(); }, false)
      : false;
    const resolvedMode = mode === 'auto'
      ? (hasNormal ? 'normal' : (hasOrganic ? 'organic' : 'none'))
      : mode;

    if (resolvedMode === 'none') {
      throw new Error('no fertilizer available');
    }
    if (resolvedMode !== 'normal' && resolvedMode !== 'organic') {
      throw new Error('unsupported fertilizer mode: ' + resolvedMode);
    }
    if (resolvedMode === 'normal' && !hasNormal) {
      throw new Error('normal fertilizer not available');
    }
    if (resolvedMode === 'organic' && !hasOrganic) {
      throw new Error('organic fertilizer not available');
    }

    openLandInteraction(targetNode);
    await wait(waitAfterOpen);

    const manager = findPlantInteractionManager();
    if (!manager) throw new Error('plant interaction manager not found');

    const targetArgForCheck = before.landId != null ? before.landId : before.path;
    const managerCanFertilize = typeof manager.canFertilize === 'function'
      ? !!safeCall(function () { return manager.canFertilize(targetArgForCheck); }, false)
      : null;
    const plantRuntime = getPlantRuntime(targetNode);
    const plantCanFertilize = plantRuntime && typeof plantRuntime.canFertilize === 'function'
      ? !!safeCall(function () { return plantRuntime.canFertilize(); }, false)
      : null;

    const payload = {
      ok: true,
      action: dryRun ? 'dry_run' : 'fertilized',
      requestedMode: rawMode,
      resolvedMode: resolvedMode,
      landId: before.landId,
      path: before.path,
      plantName: before.plantName,
      before: {
        stageKind: before.stageKind,
        matureInSec: before.matureInSec,
        currentSeason: before.currentSeason,
        totalSeason: before.totalSeason,
      },
      checks: {
        managerCanFertilize: managerCanFertilize,
        plantCanFertilize: plantCanFertilize,
        hasNormal: hasNormal,
        hasOrganic: hasOrganic,
      },
    };

    if (!managerCanFertilize && !plantCanFertilize) {
      throw new Error('target land is not fertilizable right now');
    }

    const fertilizerItem = findBestFertilizerDetailItem(itemM, resolvedMode);
    payload.fertilizerItem = summarizeInventoryEntry(fertilizerItem);
    const selectedBucket = findFirstCurrentDataFertilizerBucket(manager, resolvedMode);
    payload.selectedBucket = summarizeInventoryEntry(selectedBucket);
    payload.selectedBucketApplied = false;
    payload.targetArg = targetArgForCheck;

    primeFertilizerToolNodes(manager, selectedBucket, targetArgForCheck);
    await wait(120);

    const actionPanelReady = await ensureFertilizerActionPanel(manager);
    const actionNode = findFertilizerActionNode(resolvedMode, manager, selectedBucket);
    payload.actionNode = actionNode ? {
      path: fullPath(actionNode),
      name: actionNode.name || null,
      texts: getNodeTextList(actionNode, { maxDepth: 2 }).slice(0, 6),
    } : null;
    payload.actionPanelReady = actionPanelReady;

    let interactionNodePrimed = false;
    if (typeof manager.selectAppropriateInteractionNode === 'function') {
      safeCall(function () {
        manager.selectAppropriateInteractionNode();
        return true;
      }, null);
      await wait(80);
      interactionNodePrimed = true;
    }
    payload.interactionNodePrimed = interactionNodePrimed;
    const managerCanFertilizeAfterPrime = typeof manager.canFertilize === 'function'
      ? !!safeCall(function () { return manager.canFertilize(targetArgForCheck); }, false)
      : null;
    payload.checks.managerCanFertilizeAfterPrime = managerCanFertilizeAfterPrime;
    payload.detailPrimed = false;
    payload.detailPrimeSource = null;
    payload.managerStateAfterPrime = {
      currentDetailType: safeReadKey(manager, 'currentDetailType'),
      currentDragType: safeReadKey(manager, 'currentDragType'),
      currentToolNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentToolNodeInfo')),
      currentSeedNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentSeedNodeInfo')),
      currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
    };

    if (dryRun) {
      payload.wouldCall = 'openLandInteraction(targetLand) -> emitNodeTouch(fertilizerActionNode) -> emitNodeTouch(targetLand) -> compare matureInSec';
      payload.internalFallbackEnabled = useInternalFallback;
      payload.targetArgCandidates = {
        landId: before.landId,
        path: before.path,
      };
      if (!actionPanelReady || !actionNode) {
        payload.ok = false;
        payload.reason = !actionPanelReady ? 'action_panel_not_ready' : 'action_node_missing';
      }
      return opts.silent ? payload : out(payload);
    }

    const executionAttempts = [];
    function runAttempt(label, invoker) {
      let result = null;
      let error = null;
      try {
        result = invoker();
      } catch (err) {
        error = err && err.message ? err.message : String(err || (label + ' failed'));
      }
      executionAttempts.push({
        label: label,
        result: summarizeSpyValue(result, 1),
        error: error,
        state: {
          currentDetailType: safeReadKey(manager, 'currentDetailType'),
          currentDragType: safeReadKey(manager, 'currentDragType'),
          currentDataItems: summarizeInventoryArray(safeReadKey(manager, 'currentData'), 8),
          currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
        },
      });
      return { result: result, error: error };
    }

    const performArg = targetArgForCheck;
    payload.performArg = performArg;
    let performError = null;
    let performResult = null;
    let actionTapResult = null;
    let actionTapError = null;
    let postTap = null;
    let landRetapResult = null;
    let landRetapError = null;
    let postLandRetap = null;

    if (actionNode) {
      try {
        if (!invokeManagerToolTouch(manager, actionNode)) {
          emitNodeTouch(actionNode);
        }
        actionTapResult = true;
      } catch (err) {
        actionTapError = err && err.message ? err.message : String(err);
      }
      await wait(Math.max(waitAfterAction, 700));
      postTap = getGridState(targetNode, { silent: true, farmType: 'own' });
      payload.postTap = {
        stageKind: postTap.stageKind,
        matureInSec: postTap.matureInSec,
        currentSeason: postTap.currentSeason,
        totalSeason: postTap.totalSeason,
      };
      payload.actionTapResult = actionTapResult;
      payload.actionTapError = actionTapError;
      payload.deltaAfterTapMatureInSec = Number(before.matureInSec) && Number(postTap.matureInSec)
        ? Number(postTap.matureInSec) - Number(before.matureInSec)
        : null;
      payload.managerStateAfterTap = {
        currentDetailType: safeReadKey(manager, 'currentDetailType'),
        currentDragType: safeReadKey(manager, 'currentDragType'),
        currentToolNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentToolNodeInfo')),
        currentSeedNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentSeedNodeInfo')),
        currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
        toolNodeByBucket: summarizeNodeForClick(getToolNodeByItemId(manager, selectedBucket && selectedBucket.id)),
      };
      const effectiveDelta = payload.deltaAfterTapMatureInSec;
      if (typeof effectiveDelta === 'number' && effectiveDelta < -5) {
        payload.performResult = true;
        payload.performError = null;
        payload.executionAttempts = [{
          label: 'tapNode(actionNode)',
          result: true,
          error: null,
          state: payload.managerStateAfterTap,
        }];
        payload.after = payload.postTap;
        payload.deltaMatureInSec = effectiveDelta;
        return opts.silent ? payload : out(payload);
      }

      const directPerformTry = runAttempt('setCurrentData(targetArg)->selectAppropriateInteractionNode()->performFertilizing(targetArg)', function () {
        if (typeof manager.setCurrentData === 'function') manager.setCurrentData(performArg);
        if (typeof manager.selectAppropriateInteractionNode === 'function') manager.selectAppropriateInteractionNode();
        if (typeof manager.performFertilizing === 'function') return manager.performFertilizing(performArg);
        return null;
      });
      performResult = directPerformTry.result;
      performError = directPerformTry.error;
      await wait(Math.max(waitAfterAction, 700));
      const postActionDirectPerform = getGridState(targetNode, { silent: true, farmType: 'own' });
      payload.postActionDirectPerform = {
        stageKind: postActionDirectPerform.stageKind,
        matureInSec: postActionDirectPerform.matureInSec,
        currentSeason: postActionDirectPerform.currentSeason,
        totalSeason: postActionDirectPerform.totalSeason,
      };
      payload.deltaAfterActionDirectPerformMatureInSec = Number(before.matureInSec) && Number(postActionDirectPerform.matureInSec)
        ? Number(postActionDirectPerform.matureInSec) - Number(before.matureInSec)
        : null;
      payload.managerStateAfterActionDirectPerform = {
        currentDetailType: safeReadKey(manager, 'currentDetailType'),
        currentDragType: safeReadKey(manager, 'currentDragType'),
        currentToolNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentToolNodeInfo')),
        currentSeedNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentSeedNodeInfo')),
        currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
        currentDataState: summarizeCurrentDataState(manager),
      };
      if (typeof payload.deltaAfterActionDirectPerformMatureInSec === 'number' && payload.deltaAfterActionDirectPerformMatureInSec < -5) {
        payload.performResult = performResult;
        payload.performError = performError;
        payload.executionAttempts = executionAttempts;
        payload.after = payload.postActionDirectPerform;
        payload.deltaMatureInSec = payload.deltaAfterActionDirectPerformMatureInSec;
        payload.executionSource = 'post_action_direct_perform';
        return opts.silent ? payload : out(payload);
      }

      try {
        if (!invokeManagerLandTouch(manager, targetNode)) {
          emitNodeTouch(targetNode);
        }
        landRetapResult = true;
      } catch (err) {
        landRetapError = err && err.message ? err.message : String(err);
      }
      await wait(Math.max(waitAfterAction, 700));
      postLandRetap = getGridState(targetNode, { silent: true, farmType: 'own' });
      payload.postLandRetap = {
        stageKind: postLandRetap.stageKind,
        matureInSec: postLandRetap.matureInSec,
        currentSeason: postLandRetap.currentSeason,
        totalSeason: postLandRetap.totalSeason,
      };
      payload.landRetapResult = landRetapResult;
      payload.landRetapError = landRetapError;
      payload.deltaAfterLandRetapMatureInSec = Number(before.matureInSec) && Number(postLandRetap.matureInSec)
        ? Number(postLandRetap.matureInSec) - Number(before.matureInSec)
        : null;
      payload.managerStateAfterLandRetap = {
        currentDetailType: safeReadKey(manager, 'currentDetailType'),
        currentDragType: safeReadKey(manager, 'currentDragType'),
        currentToolNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentToolNodeInfo')),
        currentSeedNodeInfo: summarizeInteractionNodeInfoValue(safeReadKey(manager, 'currentSeedNodeInfo')),
        currentDetailComp: summarizeRuntimeObject(safeReadKey(manager, 'currentDetailComp'), 'currentDetailComp'),
        toolNodeByBucket: summarizeNodeForClick(getToolNodeByItemId(manager, selectedBucket && selectedBucket.id)),
      };
      const effectiveLandDelta = payload.deltaAfterLandRetapMatureInSec;
      if (typeof effectiveLandDelta === 'number' && effectiveLandDelta < -5) {
        payload.performResult = true;
        payload.performError = null;
        payload.executionAttempts = [{
          label: 'tapNode(actionNode)->tapNode(targetLand)',
          result: true,
          error: null,
          state: payload.managerStateAfterLandRetap,
        }];
        payload.after = payload.postLandRetap;
        payload.deltaMatureInSec = effectiveLandDelta;
        return opts.silent ? payload : out(payload);
      }
    }

    if (useInternalFallback && typeof manager.performFertilizing === 'function') {
      if ((performResult == null || performResult === false) && typeof manager.performFertilizing === 'function') {
        const secondTry = runAttempt('performFertilizing()', function () {
          return manager.performFertilizing();
        });
        if (performResult == null || performResult === false) performResult = secondTry.result;
        if (performError && !secondTry.error) performError = null;
        else if (!performError) performError = secondTry.error;
      }
    }
    if (useInternalFallback && (performResult == null || performResult === false) && typeof manager.attemptPerform === 'function') {
      const thirdTry = runAttempt('attemptPerform(targetArg)', function () {
        return manager.attemptPerform(performArg);
      });
      if (performResult == null || performResult === false) performResult = thirdTry.result;
      if (performError && !thirdTry.error) performError = null;
      else if (!performError) performError = thirdTry.error;
    }
    payload.performResult = performResult;
    payload.performError = performError;
    payload.executionAttempts = executionAttempts;
    await wait(waitAfterAction);

    const after = getGridState(targetNode, { silent: true, farmType: 'own' });
    payload.after = {
      stageKind: after.stageKind,
      matureInSec: after.matureInSec,
      currentSeason: after.currentSeason,
      totalSeason: after.totalSeason,
    };
    payload.deltaMatureInSec = Number(before.matureInSec) && Number(after.matureInSec)
      ? Number(after.matureInSec) - Number(before.matureInSec)
      : null;
    return opts.silent ? payload : out(payload);
  }

  function normalizeKeywords(keyword) {
    if (keyword == null) return [];
    if (Array.isArray(keyword)) return keyword.map(x => String(x).toLowerCase()).filter(Boolean);
    return String(keyword)
      .split(/[,\s]+/)
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);
  }

  function matchesKeywords(texts, keywords) {
    if (!keywords || keywords.length === 0) return true;
    const joined = (Array.isArray(texts) ? texts : [texts])
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    for (let i = 0; i < keywords.length; i++) {
      if (joined.indexOf(keywords[i]) >= 0) return true;
    }
    return false;
  }

  function rectArea(rect) {
    return rect ? Math.max(0, Number(rect.width) || 0) * Math.max(0, Number(rect.height) || 0) : 0;
  }

  function pointInRect(point, rect) {
    if (!point || !rect) return false;
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }

  function buildOverlayCloseButtons(node, closeKeywords, camera) {
    return walk(node)
      .filter(child => !!(child && child.activeInHierarchy && child.getComponent))
      .map(child => {
        const btn = child.getComponent(cc.Button);
        if (!btn || !btn.interactable || !btn.enabledInHierarchy) return null;
        const texts = getNodeTextList(child, { maxDepth: 2 });
        const handlers = getHandlers(btn).map(item => item.text);
        const info = describeNode(child, { camera });
        const haystack = [info.path, info.relativePath, info.name].concat(info.components || [], texts, handlers);
        if (!matchesKeywords(haystack, closeKeywords)) return null;
        const rect = getNodeScreenRect(child, { camera });
        return {
          path: info.path,
          relativePath: info.relativePath,
          name: info.name,
          texts,
          handlers,
          rect
        };
      })
      .filter(Boolean)
      .sort((a, b) => rectArea(a.rect) - rectArea(b.rect))
      .slice(0, 6);
  }

  function buildOverlayBlankTapPoint(node, overlayRect, viewport, camera) {
    if (!overlayRect || !viewport || !viewport.width || !viewport.height) return null;

    const overlayArea = rectArea(overlayRect);
    const descendants = walk(node)
      .slice(1)
      .filter(child => !!(child && child.activeInHierarchy))
      .map(child => ({
        node: child,
        rect: getNodeScreenRect(child, { camera })
      }))
      .filter(item => item.rect)
      .filter(item => rectArea(item.rect) >= overlayArea * 0.08)
      .filter(item => rectArea(item.rect) <= overlayArea * 0.92)
      .sort((a, b) => rectArea(b.rect) - rectArea(a.rect));

    const blockingRects = descendants.slice(0, 8).map(item => item.rect);
    const panelRect = blockingRects.length > 0 ? blockingRects[0] : null;
    const margin = 24;
    const points = [];

    function pushPoint(x, y, reason) {
      const point = {
        x: roundNum(x),
        y: roundNum(y),
        reason
      };
      if (!pointInRect(point, overlayRect)) return;
      for (let i = 0; i < blockingRects.length; i++) {
        if (pointInRect(point, blockingRects[i])) return;
      }
      points.push(point);
    }

    if (panelRect) {
      pushPoint(overlayRect.centerX, Math.max(overlayRect.top + margin, roundNum((overlayRect.top + panelRect.top) / 2)), 'above_panel');
      pushPoint(overlayRect.centerX, Math.min(overlayRect.bottom - margin, roundNum((panelRect.bottom + overlayRect.bottom) / 2)), 'below_panel');
      pushPoint(Math.max(overlayRect.left + margin, roundNum((overlayRect.left + panelRect.left) / 2)), overlayRect.centerY, 'left_of_panel');
      pushPoint(Math.min(overlayRect.right - margin, roundNum((panelRect.right + overlayRect.right) / 2)), overlayRect.centerY, 'right_of_panel');
    }

    pushPoint(overlayRect.left + margin, overlayRect.top + margin, 'top_left');
    pushPoint(overlayRect.right - margin, overlayRect.top + margin, 'top_right');
    pushPoint(overlayRect.left + margin, overlayRect.bottom - margin, 'bottom_left');
    pushPoint(overlayRect.right - margin, overlayRect.bottom - margin, 'bottom_right');

    return points.length > 0 ? points[0] : null;
  }

  function detectActiveOverlays(opts) {
    opts = opts || {};
    const root = scene();
    const camera = getCamera();
    const viewport = getViewportInfo();
    const viewportArea = Math.max(1, viewport.width * viewport.height);
    const overlayKeywords = normalizeKeywords(opts.keywords || opts.keyword || [
      'mask', 'overlay', 'popup', 'dialog', 'modal', 'reward', 'award', 'prize', 'gift', 'panel',
      '获得', '奖励', '道具', '礼包', '弹窗', '蒙层', '遮罩'
    ]);
    const excludeKeywords = normalizeKeywords(opts.excludeKeywords || [
      'farm_scene', 'farm_scene_v3', 'gridorigin', 'plantorigin', 'main_ui_v2', 'layerui',
      'mainmenucomp', 'mainuicomp', 'oneclickoperationtools', 'node_warehouse', 'menu', 'foot', 'root'
    ]);
    const closeKeywords = normalizeKeywords(opts.closeKeywords || [
      'close', 'btn_close', 'cancel', 'ok', 'confirm', 'sure', 'back', 'x',
      '关闭', '取消', '确定', '知道了', '收下'
    ]);
    const minAreaRatio = opts.minAreaRatio == null ? 0.12 : Math.max(0, Number(opts.minAreaRatio) || 0);
    const minScore = opts.minScore == null ? 4 : Number(opts.minScore) || 0;
    const limit = opts.limit == null ? 8 : Math.max(1, Number(opts.limit) || 1);

    const rawCandidates = walk(root)
      .filter(node => !!(node && node.activeInHierarchy && node !== root && node.getComponent))
      .map(node => {
        const info = describeNode(node, { baseNode: root, camera });
        const rect = getNodeScreenRect(node, { camera });
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;

        const areaRatio = rectArea(rect) / viewportArea;
        if (areaRatio < minAreaRatio) return null;

        const texts = getNodeTextList(node, { maxDepth: 2 });
        const haystack = [info.path, info.relativePath, info.name].concat(info.components || [], texts);
        let score = 0;
        const reasons = [];

        if (areaRatio >= 0.7) {
          score += 4;
          reasons.push('fullscreen');
        } else if (areaRatio >= 0.4) {
          score += 3;
          reasons.push('large_area');
        } else {
          score += 1;
          reasons.push('area');
        }

        if (matchesKeywords(haystack, overlayKeywords)) {
          score += 3;
          reasons.push('keyword');
        }

        if (matchesKeywords(info.components || [], ['blockinputevents'])) {
          score += 4;
          reasons.push('block_input');
        }

        if (matchesKeywords(info.components || [], ['button'])) {
          score += 1;
          reasons.push('button_component');
        }

        if (info.depth >= 5) {
          score += 1;
          reasons.push('deep_ui');
        }

        if (matchesKeywords([info.name].concat(info.components || []), excludeKeywords)) {
          score -= 4;
          reasons.push('common_ui_penalty');
        }

        if (info.depth <= 2) {
          score -= 2;
          reasons.push('shallow_penalty');
        }

        if (info.childCount > 80) {
          score -= 2;
          reasons.push('too_many_children_penalty');
        }

        if (score < minScore) return null;

        return {
          node,
          info,
          rect,
          texts,
          areaRatio: roundNum(areaRatio),
          score,
          reasons
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.areaRatio !== a.areaRatio) return b.areaRatio - a.areaRatio;
        return b.info.depth - a.info.depth;
      })
      .slice(0, limit);

    const list = rawCandidates.map(item => {
      const closeButtons = buildOverlayCloseButtons(item.node, closeKeywords, camera);
      const blankTapPoint = buildOverlayBlankTapPoint(item.node, item.rect, viewport, camera);
      return {
        path: item.info.path,
        relativePath: item.info.relativePath,
        name: item.info.name,
        depth: item.info.depth,
        childCount: item.info.childCount,
        components: item.info.components,
        texts: item.texts,
        rect: item.rect,
        areaRatio: item.areaRatio,
        score: item.score,
        reasons: item.reasons,
        closeButtons,
        closeButtonCount: closeButtons.length,
        blankTapPoint
      };
    });

    const payload = {
      viewport,
      count: list.length,
      list
    };
    return opts.silent ? payload : out(payload);
  }

  async function dismissActiveOverlay(opts) {
    opts = opts || {};
    const hold = opts.hold == null ? 32 : Number(opts.hold);
    const waitAfter = opts.waitAfter == null ? 300 : Number(opts.waitAfter);
    const detected = detectActiveOverlays({
      ...opts,
      silent: true,
      limit: opts.limit == null ? 1 : opts.limit
    });
    const target = detected && Array.isArray(detected.list) && detected.list.length > 0 ? detected.list[0] : null;
    if (!target) {
      const miss = { ok: false, reason: 'overlay_not_found', detected };
      return opts.silent ? miss : out(miss);
    }

    let action = null;
    if (target.closeButtons && target.closeButtons.length > 0) {
      action = {
        type: 'close_button',
        button: target.closeButtons[0],
        result: smartClick(target.closeButtons[0].path)
      };
    } else if (target.blankTapPoint) {
      action = {
        type: 'blank_tap',
        point: target.blankTapPoint,
        result: tap(target.blankTapPoint.x, target.blankTapPoint.y, hold)
      };
    } else {
      const miss = { ok: false, reason: 'dismiss_target_not_found', target };
      return opts.silent ? miss : out(miss);
    }

    if (waitAfter > 0) {
      await wait(waitAfter);
    }

    const after = detectActiveOverlays({
      ...opts,
      silent: true,
      limit: opts.limit == null ? 3 : opts.limit
    });

    const payload = {
      ok: true,
      target,
      action,
      after
    };
    return opts.silent ? payload : out(payload);
  }

  function collectRewardPopupTextMatches(opts) {
    opts = opts || {};
    const root = scene();
    const camera = getCamera();
    const viewport = getViewportInfo();
    const patterns = opts.rewardPatterns || [
      /恭喜获得/,
      /点击空白处关闭/,
      /奖励/,
      /道具/,
      /种子/,
      /获得/
    ];
    return walk(root)
      .filter(function (node) { return !!(node && node.activeInHierarchy); })
      .map(function (node) {
        const texts = getNodeTextList(node, { maxDepth: 1 });
        if (!texts || texts.length === 0) return null;
        const matchedTexts = texts.filter(function (text) {
          return patterns.some(function (pattern) {
            return pattern.test(String(text || '').trim());
          });
        });
        if (matchedTexts.length <= 0) return null;
        const rect = getNodeScreenRect(node, { camera: camera });
        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
        return {
          node: node,
          path: fullPath(node),
          relativePath: relativePath(node),
          texts: texts,
          matchedTexts: matchedTexts,
          rect: rect,
          areaRatio: rectArea(rect) / Math.max(1, viewport.width * viewport.height),
          components: componentNames(node),
        };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        if (b.matchedTexts.length !== a.matchedTexts.length) return b.matchedTexts.length - a.matchedTexts.length;
        return b.areaRatio - a.areaRatio;
      })
      .slice(0, 24);
  }

  function buildRewardPopupTargetFromTextMatches(matches, opts) {
    opts = opts || {};
    const list = Array.isArray(matches) ? matches : [];
    if (list.length <= 0) return null;
    const viewport = getViewportInfo();
    const viewportArea = Math.max(1, viewport.width * viewport.height);
    const camera = getCamera();
    let best = null;

    function consider(node, sourceMatch) {
      if (!node || !node.activeInHierarchy) return;
      const rect = getNodeScreenRect(node, { camera: camera });
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const areaRatio = rectArea(rect) / viewportArea;
      let score = 0;
      const components = componentNames(node);
      const texts = getNodeTextList(node, { maxDepth: 2 });
      if (areaRatio >= 0.75) score += 8;
      else if (areaRatio >= 0.45) score += 6;
      else if (areaRatio >= 0.2) score += 3;
      if (matchesKeywords(components, ['blockinputevents'])) score += 8;
      if (matchesKeywords([node.name].concat(components), ['mask', 'overlay', 'popup', 'dialog', 'modal', 'reward', 'award', 'gift'])) score += 5;
      if (matchesKeywords(texts, ['恭喜获得', '点击空白处关闭'])) score += 3;
      if (node.parent && node.parent === scene()) score -= 2;
      if (rect.top <= 8 && rect.left <= 8) score += 1;
      if (sourceMatch && sourceMatch.rect && pointInRect({ x: sourceMatch.rect.centerX, y: sourceMatch.rect.centerY }, rect)) score += 2;
      if (!best || score > best.score || (score === best.score && areaRatio > best.areaRatio)) {
        best = {
          score: score,
          areaRatio: areaRatio,
          path: fullPath(node),
          relativePath: relativePath(node),
          name: node.name || '',
          depth: nodeDepth(node),
          childCount: (node.children && node.children.length) || 0,
          components: components,
          texts: texts,
          rect: rect,
          closeButtons: buildOverlayCloseButtons(node, normalizeKeywords([
            'close', 'btn_close', 'cancel', 'ok', 'confirm', 'sure', 'back', 'x',
            '关闭', '取消', '确定', '知道了', '收下'
          ]), camera),
          closeButtonCount: 0,
          blankTapPoint: buildOverlayBlankTapPoint(node, rect, viewport, camera),
          sourceMatch: sourceMatch ? {
            path: sourceMatch.path,
            texts: sourceMatch.matchedTexts,
            rect: sourceMatch.rect,
          } : null,
        };
        best.closeButtonCount = best.closeButtons.length;
      }
    }

    for (let i = 0; i < list.length; i += 1) {
      const match = list[i];
      for (let node = match.node, depth = 0; node && depth < 8; node = node.parent, depth += 1) {
        consider(node, match);
      }
    }
    return best;
  }

  function buildRewardDismissFallbackPoints(target, matches) {
    const viewport = getViewportInfo();
    const points = [];
    const blocks = [];
    if (target && target.rect) blocks.push(target.rect);
    (Array.isArray(matches) ? matches : []).forEach(function (item) {
      if (item && item.rect) blocks.push(item.rect);
    });

    function inBlocked(x, y) {
      for (let i = 0; i < blocks.length; i += 1) {
        if (pointInRect({ x: x, y: y }, blocks[i])) return true;
      }
      return false;
    }

    function pushPoint(x, y, reason) {
      const px = Math.max(18, Math.min(viewport.width - 18, Math.round(Number(x) || 0)));
      const py = Math.max(18, Math.min(viewport.height - 18, Math.round(Number(y) || 0)));
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      if (inBlocked(px, py)) return;
      for (let i = 0; i < points.length; i += 1) {
        if (points[i].x === px && points[i].y === py) return;
      }
      points.push({ x: px, y: py, reason: reason || 'fallback' });
    }

    if (target && target.blankTapPoint) {
      pushPoint(target.blankTapPoint.x, target.blankTapPoint.y, 'target_blank');
    }

    pushPoint(viewport.width * 0.5, viewport.height * 0.92, 'bottom_center');
    pushPoint(viewport.width * 0.5, viewport.height * 0.08, 'top_center');
    pushPoint(viewport.width * 0.08, viewport.height * 0.5, 'left_center');
    pushPoint(viewport.width * 0.92, viewport.height * 0.5, 'right_center');
    pushPoint(viewport.width * 0.1, viewport.height * 0.12, 'top_left');
    pushPoint(viewport.width * 0.9, viewport.height * 0.12, 'top_right');
    pushPoint(viewport.width * 0.1, viewport.height * 0.88, 'bottom_left');
    pushPoint(viewport.width * 0.9, viewport.height * 0.88, 'bottom_right');

    if (target && target.rect) {
      pushPoint(target.rect.centerX, target.rect.top - 30, 'above_target');
      pushPoint(target.rect.centerX, target.rect.bottom + 30, 'below_target');
      pushPoint(target.rect.left - 30, target.rect.centerY, 'left_of_target');
      pushPoint(target.rect.right + 30, target.rect.centerY, 'right_of_target');
    }

    return points;
  }

  async function dismissOverlayTarget(target, opts) {
    opts = opts || {};
    const hold = opts.hold == null ? 32 : Number(opts.hold);
    const waitAfter = opts.waitAfter == null ? 300 : Number(opts.waitAfter);
    if (!target || typeof target !== 'object') {
      const miss = { ok: false, reason: 'overlay_target_required', target: target || null };
      return opts.silent ? miss : out(miss);
    }

    let action = null;
    if (target.closeButtons && target.closeButtons.length > 0) {
      action = {
        type: 'close_button',
        button: target.closeButtons[0],
        result: smartClick(target.closeButtons[0].path)
      };
    } else if (target.blankTapPoint) {
      action = {
        type: 'blank_tap',
        point: target.blankTapPoint,
        result: tap(target.blankTapPoint.x, target.blankTapPoint.y, hold)
      };
    } else {
      const miss = { ok: false, reason: 'dismiss_target_not_found', target };
      return opts.silent ? miss : out(miss);
    }

    if (waitAfter > 0) {
      await wait(waitAfter);
    }

    const after = detectActiveOverlays({
      ...opts,
      silent: true,
      limit: opts.limit == null ? 3 : opts.limit
    });

    const payload = {
      ok: true,
      target,
      action,
      after
    };
    return opts.silent ? payload : out(payload);
  }

  async function dismissRewardOverlayByViewport(target, opts) {
    opts = opts || {};
    const hold = opts.hold == null ? 32 : Number(opts.hold);
    const waitAfterEach = opts.waitAfterEach == null ? 180 : Number(opts.waitAfterEach);
    const matches = Array.isArray(opts.matches) ? opts.matches : collectRewardPopupTextMatches(opts);
    const points = buildRewardDismissFallbackPoints(target, matches);

    const attempts = [];
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      tap(point.x, point.y, hold);
      if (waitAfterEach > 0) await wait(waitAfterEach);
      const detected = detectActiveOverlays({
        ...opts,
        ...buildRewardOverlayDismissOptions(opts),
        silent: true,
        limit: 2,
      });
      const stillVisible = detected && Array.isArray(detected.list)
        ? detected.list.some(function (item) {
            const texts = Array.isArray(item && item.texts) ? item.texts : [];
            return /恭喜获得|点击空白处关闭|奖励|道具|种子/.test(texts.join(' '));
          })
        : false;
      attempts.push({
        point,
        stillVisible,
      });
      if (!stillVisible) {
        return {
          ok: true,
          action: 'dismiss_reward_popup_viewport_fallback',
          point,
          matchedTextCount: matches.length,
          attempts,
          after: detected,
        };
      }
    }

    return {
      ok: false,
      reason: 'reward_popup_viewport_fallback_failed',
      attempts,
    };
  }

  function buildRewardOverlayDismissOptions(opts) {
    const base = opts && typeof opts === 'object' ? { ...opts } : {};
    return {
      ...base,
      limit: base.limit == null ? 2 : base.limit,
      minAreaRatio: base.minAreaRatio == null ? 0.18 : base.minAreaRatio,
      keywords: normalizeKeywords([
        'reward', 'award', 'prize', 'gift', 'popup', 'overlay', 'modal',
        '恭喜获得', '获得', '奖励', '道具', '种子', '点击空白处关闭'
      ].concat(base.keywords || base.keyword || [])),
      closeKeywords: normalizeKeywords([
        'close', 'ok', 'confirm', 'sure', '收下', '确定', '关闭', '知道了'
      ].concat(base.closeKeywords || [])),
      excludeKeywords: normalizeKeywords([
        '土地升级', '升级', '商店', '仓库', '背包'
      ].concat(base.excludeKeywords || [])),
    };
  }

  function inspectRewardPopupTextMatches(opts) {
    const matches = collectRewardPopupTextMatches(opts).map(function (item) {
      return {
        path: item.path,
        relativePath: item.relativePath,
        texts: item.texts,
        matchedTexts: item.matchedTexts,
        rect: item.rect,
        areaRatio: roundNum(item.areaRatio),
        components: item.components,
      };
    });
    const payload = {
      viewport: getViewportInfo(),
      count: matches.length,
      list: matches,
    };
    return opts && opts.silent ? payload : out(payload);
  }

  function inspectRewardPopupTarget(opts) {
    const detectOpts = buildRewardOverlayDismissOptions(opts);
    const rewardTextMatches = collectRewardPopupTextMatches(detectOpts);
    const rewardTextTarget = buildRewardPopupTargetFromTextMatches(rewardTextMatches, detectOpts);
    const detected = detectActiveOverlays({
      ...detectOpts,
      silent: true,
    });
    const overlayTarget = detected && Array.isArray(detected.list)
      ? detected.list.find(function (item) {
          const texts = Array.isArray(item && item.texts) ? item.texts : [];
          return /恭喜获得|点击空白处关闭|奖励|道具|种子/.test(texts.join(' '));
        }) || detected.list[0]
      : null;
    const payload = {
      viewport: getViewportInfo(),
      rewardTextMatches: rewardTextMatches.map(function (item) {
        return {
          path: item.path,
          relativePath: item.relativePath,
          texts: item.texts,
          matchedTexts: item.matchedTexts,
          rect: item.rect,
          areaRatio: roundNum(item.areaRatio),
          components: item.components,
        };
      }),
      rewardTextTarget: rewardTextTarget,
      overlayTarget: overlayTarget,
      finalTarget: rewardTextTarget || overlayTarget || null,
      fallbackPoints: buildRewardDismissFallbackPoints(rewardTextTarget || overlayTarget || null, rewardTextMatches),
      detected: detected,
    };
    return opts && opts.silent ? payload : out(payload);
  }

  async function dismissRewardPopup(opts) {
    const silent = !!(opts && opts.silent);
    const retries = Math.max(1, Number(opts && opts.retries) || 3);
    const retryWaitMs = Math.max(80, Number(opts && opts.retryWaitMs) || 180);
    let lastDetected = null;
    let lastPayload = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const detectOpts = buildRewardOverlayDismissOptions(opts);
      const rewardTextMatches = collectRewardPopupTextMatches(detectOpts);
      const rewardTextTarget = buildRewardPopupTargetFromTextMatches(rewardTextMatches, detectOpts);
      const detected = detectActiveOverlays({
        ...detectOpts,
        silent: true,
      });
      lastDetected = detected;
      const overlayTarget = detected && Array.isArray(detected.list)
        ? detected.list.find(function (item) {
            const texts = Array.isArray(item && item.texts) ? item.texts : [];
            return /恭喜获得|点击空白处关闭|奖励|道具|种子/.test(texts.join(' '));
          }) || detected.list[0]
        : null;
      const target = rewardTextTarget || overlayTarget;
      if (!target) {
        lastPayload = {
          ok: false,
          reason: 'reward_popup_not_found',
          detected,
          rewardTextMatches,
          attempt: attempt + 1
        };
        if (attempt < retries - 1) {
          await wait(retryWaitMs);
          continue;
        }
        return silent ? lastPayload : out(lastPayload);
      }
      let result = await dismissOverlayTarget(target, {
        ...detectOpts,
        silent: true,
        limit: 1,
      });
      if (!result || result.ok !== true) {
        result = await dismissRewardOverlayByViewport(target, {
          ...detectOpts,
          silent: true,
          hold: opts && opts.hold,
          matches: rewardTextMatches,
        });
      }
      lastPayload = {
        ...result,
        action: 'dismiss_reward_popup',
        detected,
        rewardTextMatches,
        matchedTarget: target,
        attempt: attempt + 1,
      };
      if (result && result.ok) {
        return silent ? lastPayload : out(lastPayload);
      }
      if (attempt < retries - 1) {
        await wait(retryWaitMs);
      }
    }
    return silent ? lastPayload || { ok: false, reason: 'reward_popup_not_found', detected: lastDetected } : out(lastPayload || { ok: false, reason: 'reward_popup_not_found', detected: lastDetected });
  }

  function farmNodes(opts) {
    opts = opts || {};
    const root = findFarmRoot(opts.root || opts.path);
    if (!root) throw new Error('Farm root not found');

    const activeOnly = opts.activeOnly !== false;
    const leafOnly = !!opts.leafOnly;
    const minWidth = opts.minWidth == null ? null : Number(opts.minWidth);
    const minHeight = opts.minHeight == null ? null : Number(opts.minHeight);
    const keywords = normalizeKeywords(opts.keyword || opts.keywords);
    const camera = getCamera();

    return walk(root)
      .filter(node => !activeOnly || node.activeInHierarchy)
      .filter(node => !leafOnly || !node.children || node.children.length === 0)
      .map(node => describeNode(node, { baseNode: root, camera }))
      .filter(info => {
        if (minWidth != null && (!info.size || info.size.width < minWidth)) return false;
        if (minHeight != null && (!info.size || info.size.height < minHeight)) return false;
        if (!matchesKeywords([info.path, info.relativePath, info.name].concat(info.components || []), keywords)) return false;
        return true;
      });
  }

  function dumpFarmNodes(keyword, opts) {
    if (keyword && typeof keyword === 'object') {
      opts = keyword;
      keyword = opts.keyword || opts.keywords;
    }
    opts = opts || {};
    if (keyword != null) opts.keyword = keyword;
    return out(farmNodes(opts));
  }

  function guessFarmCandidates(opts) {
    opts = opts || {};
    const nameKeywords = normalizeKeywords(
      opts.keywords || opts.keyword || [
        'land', 'plant', 'crop', 'fruit', 'soil', 'farm', 'plot',
        'harvest', 'mature', 'ripe', 'collect', 'pick'
      ]
    );
    const componentKeywords = normalizeKeywords(
      opts.componentKeywords || ['plant', 'land', 'farm', 'crop', 'fruit']
    );

    return farmNodes({
      ...opts,
      keyword: null,
      activeOnly: opts.activeOnly !== false,
      leafOnly: !!opts.leafOnly
    }).filter(info => {
      if (opts.excludeButtons !== false && info.button) return false;
      if (opts.requireSize !== false && (!info.size || !info.size.width || !info.size.height)) return false;
      if (opts.maxChildCount != null && info.childCount > opts.maxChildCount) return false;

      const hitName = matchesKeywords([info.path, info.relativePath, info.name], nameKeywords);
      const hitComp = matchesKeywords(info.components || [], componentKeywords);
      return hitName || hitComp;
    });
  }

  function dumpFarmCandidates(keyword, opts) {
    if (keyword && typeof keyword === 'object') {
      opts = keyword;
      keyword = opts.keyword || opts.keywords;
    }
    opts = opts || {};
    if (keyword != null) opts.keyword = keyword;
    return out(guessFarmCandidates(opts));
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function summarizeSpecialObject(value) {
    if (!value || typeof value !== 'object') return null;
    if (value instanceof cc.Node) {
      return { __type: 'Node', path: fullPath(value) };
    }
    if (value instanceof cc.Component) {
      return {
        __type: value.constructor ? value.constructor.name : 'Component',
        node: value.node ? fullPath(value.node) : null
      };
    }

    const ctorName = value.constructor && value.constructor.name;
    if (!ctorName) return null;

    const scalarKeys = ['x', 'y', 'z', 'w', 'width', 'height', 'r', 'g', 'b', 'a'];
    let hit = false;
    const picked = { __type: ctorName };
    for (let i = 0; i < scalarKeys.length; i++) {
      const key = scalarKeys[i];
      if (typeof value[key] === 'number' && isFinite(value[key])) {
        picked[key] = roundNum(value[key]);
        hit = true;
      }
    }
    return hit ? picked : null;
  }

  function serializeValue(value, depth, seen) {
    if (value == null) return value;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return isFinite(value) ? roundNum(value) : String(value);
    if (t === 'bigint') return String(value);
    if (t === 'function' || t === 'symbol') return undefined;

    const special = summarizeSpecialObject(value);
    if (special) return special;

    if (depth <= 0) {
      const ctorName = value && value.constructor && value.constructor.name;
      return ctorName ? { __type: ctorName } : undefined;
    }

    if (seen.has(value)) return { __type: 'Circular' };
    seen.add(value);

    if (Array.isArray(value)) {
      const arr = [];
      for (let i = 0; i < value.length && i < 10; i++) {
        const item = serializeValue(value[i], depth - 1, seen);
        if (item !== undefined) arr.push(item);
      }
      return arr;
    }

    if (!isPlainObject(value)) {
      const ctorName = value && value.constructor && value.constructor.name;
      return ctorName ? { __type: ctorName } : undefined;
    }

    const keys = Object.keys(value).sort().slice(0, 20);
    const outObj = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const item = serializeValue(value[key], depth - 1, seen);
      if (item !== undefined) outObj[key] = item;
    }
    return Object.keys(outObj).length > 0 ? outObj : undefined;
  }

  function snapshotNode(pathOrNode, opts) {
    opts = opts || {};
    const node = toNode(pathOrNode);
    if (!node) throw new Error('Node not found: ' + pathOrNode);

    const componentDepth = opts.componentDepth == null ? 1 : Number(opts.componentDepth);
    const skipKeys = opts.skipKeys || ['_eventProcessor', '_uiProps', '__eventTargets', 'hideFlags'];
    const info = describeNode(node);
    const snapshot = {
      capturedAt: Date.now(),
      path: fullPath(node),
      summary: info,
      nodeState: {
        active: !!node.active,
        activeInHierarchy: !!node.activeInHierarchy,
        layer: node.layer == null ? null : node.layer,
        childCount: info.childCount
      },
      components: []
    };

    const components = node.components || [];
    for (let i = 0; i < components.length; i++) {
      const comp = components[i];
      const entry = {
        index: i,
        name: comp && comp.constructor ? comp.constructor.name : String(comp),
        enabled: comp && comp.enabled != null ? !!comp.enabled : null,
        props: {}
      };

      const keys = Object.keys(comp || {}).sort();
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (skipKeys.indexOf(key) >= 0) continue;
        let value;
        try {
          value = comp[key];
        } catch (_) {
          continue;
        }
        const serialized = serializeValue(value, componentDepth, new WeakSet());
        if (serialized !== undefined) entry.props[key] = serialized;
      }

      snapshot.components.push(entry);
    }

    snapshot.flat = flattenSnapshot(snapshot);
    return out(snapshot);
  }

  function flattenValue(prefix, value, outMap) {
    if (value == null || typeof value !== 'object') {
      outMap[prefix] = value;
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        outMap[prefix] = [];
        return;
      }
      for (let i = 0; i < value.length; i++) {
        flattenValue(prefix + '[' + i + ']', value[i], outMap);
      }
      return;
    }

    const keys = Object.keys(value);
    if (keys.length === 0) {
      outMap[prefix] = {};
      return;
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      flattenValue(prefix ? prefix + '.' + key : key, value[key], outMap);
    }
  }

  function flattenSnapshot(snapshot) {
    const outMap = {};
    flattenValue('', {
      path: snapshot.path,
      summary: snapshot.summary,
      nodeState: snapshot.nodeState,
      components: snapshot.components
    }, outMap);
    return outMap;
  }

  function diffSnapshots(before, after, opts) {
    opts = opts || {};
    const ignoreKeys = normalizeKeywords(opts.ignoreKeys || ['capturedat']);
    const beforeFlat = before && before.flat ? before.flat : flattenSnapshot(before || {});
    const afterFlat = after && after.flat ? after.flat : flattenSnapshot(after || {});
    const keys = Array.from(new Set(Object.keys(beforeFlat).concat(Object.keys(afterFlat)))).sort();
    const changes = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (matchesKeywords(key, ignoreKeys)) continue;
      const a = beforeFlat[key];
      const b = afterFlat[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ key, before: a, after: b });
      }
    }

    return out(changes);
  }

  async function tapAndSnapshot(pathOrNode, opts) {
    opts = opts || {};
    const hold = opts.hold == null ? 32 : Number(opts.hold);
    const waitAfterTap = opts.waitAfterTap == null ? 250 : Number(opts.waitAfterTap);
    const before = snapshotNode(pathOrNode, opts.snapshotOptions);
    tapNode(pathOrNode, hold);
    await wait(waitAfterTap);
    const after = snapshotNode(pathOrNode, opts.snapshotOptions);
    return out({
      path: before.path,
      before,
      after,
      changes: diffSnapshots(before, after, opts.diffOptions)
    });
  }

  async function batchTap(pathsOrNodes, opts) {
    opts = opts || {};
    const hold = opts.hold == null ? 32 : Number(opts.hold);
    const interval = opts.interval == null ? 180 : Number(opts.interval);
    const dryRun = !!opts.dryRun;
    const stopOnError = !!opts.stopOnError;
    const limit = opts.limit == null ? Infinity : Number(opts.limit);
    const seen = new Set();
    const rawList = Array.isArray(pathsOrNodes) ? pathsOrNodes : [pathsOrNodes];
    const list = rawList
      .map(item => {
        if (!item) return null;
        if (typeof item === 'string') return item;
        if (item.path) return item.path;
        return fullPath(item);
      })
      .filter(Boolean);
    const results = [];

    for (let i = 0; i < list.length && results.length < limit; i++) {
      const path = list[i];
      if (seen.has(path)) continue;
      seen.add(path);

      try {
        const node = findNode(path);
        if (!node) throw new Error('Node not found');

        const point = nodeToClient(node);
        if (!dryRun) tapNode(node, hold);
        results.push({
          index: results.length,
          path,
          x: point.x,
          y: point.y,
          action: dryRun ? 'skip-tap(dry-run)' : 'tap'
        });
      } catch (e) {
        results.push({
          index: results.length,
          path,
          error: e && e.message ? e.message : String(e)
        });
        if (stopOnError) break;
      }

      if (i < list.length - 1 && interval > 0) {
        await wait(interval);
      }
    }

    return out({
      action: 'batchTap',
      dryRun,
      hold,
      interval,
      count: results.length,
      results
    });
  }

  async function tapFarmCandidates(keyword, opts) {
    if (keyword && typeof keyword === 'object') {
      opts = keyword;
      keyword = opts.keyword || opts.keywords;
    }
    opts = opts || {};
    if (keyword != null) opts.keyword = keyword;

    const candidates = guessFarmCandidates(opts);
    const sliced = opts.limit == null ? candidates : candidates.slice(0, Number(opts.limit));

    return out({
      candidates: sliced,
      batch: await batchTap(sliced.map(x => x.path), opts)
    });
  }

  G.gameCtl = {
    cc,
    wait,
    scene,
    walk,
    fullPath,
    relativePath,
    relativePathFrom,
    findNode,
    toNode,
    nodeInfo,
    allButtons,
    dumpButtons,
    buttonInfo,
    triggerButton,
    tap,
    getViewportInfo,
    nodeToClient,
    getNodeScreenRect,
    tapNode,
    smartClick,
    findFarmRoot,
    findGridOrigin,
    findPlantOrigin,
    findMainUIComp,
    findMainMenuComp,
    getFarmOwnership,
    getFriendList,
    getSelfGid,
    enterFarmByGid,
    enterOwnFarm,
    enterFriendFarm,
    getFarmEntity,
    getFarmModel,
    inspectFarmModelRuntime,
    inspectMainUiRuntime,
    inspectFarmComponentCandidates,
    getFarmWorkSummary,
    getFarmStatus,
    farmNodes,
    dumpFarmNodes,
    guessFarmCandidates,
    dumpFarmCandidates,
    getGridComponent,
    getPlantComponent,
    getGridCoords,
    getPlantNodeByGrid,
    getGridNodeByPlant,
    parseGrowPhases,
    getPlantRuntime,
    getPlantStageSummary,
    getGridState,
    PlantStage,
    summarizeAllGrids,
    findHarvestableGrids,
    findMatureGrids,
    findActionableGrids,
    findWaterableGrids,
    findEraseGrassGrids,
    findKillBugGrids,
    findDeadGrids,
    inspectOneClickToolNodes,
    findOneClickManager,
    getOneClickManagerState,
    triggerOneClickOperation: triggerOneClickOperationAndDismiss,
    triggerOneClickHarvest,
    getPlayerProfile,
    getPlayerProfileDebug,
    scanAccountRuntimeDebug,
    scanSystemAccountCandidates,
    getSeedList,
    requestShopData,
    getShopSeedList,
    inspectShopModelRuntime,
    inspectShopUi,
    clickMatureEffect,
    autoPlant,
    getReconnectPromptState,
    clickReconnectPrompt,
    autoReconnectIfNeeded,
    getReconnectWatcherState,
    startReconnectWatcher,
    stopReconnectWatcher,
    openLandInteraction,
    inspectLandDetail,
    inspectFertilizerRuntime,
    inspectProtocolTransport,
    inspectRecentClickTrace,
    fertilizeLand,
    openLandAndDiffButtons,
    detectActiveOverlays,
    inspectRewardPopupTextMatches,
    inspectRewardPopupTarget,
    dismissActiveOverlay,
    dismissRewardPopup,
    snapshotNode,
    diffSnapshots,
    tapAndSnapshot,
    batchTap,
    tapFarmCandidates
  };

  safeCall(function () {
    installRuntimeSpies();
    installInteractionManagerSpies();
    ensureInteractionManagerSpyRetry();
    startReconnectWatcher({ silent: true });
  }, null);

  out({
    ready: true,
    scene: scene() ? scene().name : null,
    farmRoot: (findFarmRoot() && fullPath(findFarmRoot())) || null,
    api: [
      'gameCtl.dumpButtons(keyword, opts)',
      'gameCtl.smartClick(path, index)',
      'gameCtl.detectActiveOverlays(opts)',
      'gameCtl.dismissActiveOverlay(opts)',
      'gameCtl.dismissRewardPopup(opts)',
      'gameCtl.dumpFarmNodes(keyword, opts)',
      'gameCtl.dumpFarmCandidates(keyword, opts)',
      'gameCtl.getFarmOwnership()',
      'gameCtl.getFriendList(opts)',
      'gameCtl.enterOwnFarm(opts)',
      'gameCtl.enterFriendFarm(target, opts)',
      'gameCtl.getFarmWorkSummary()',
      'gameCtl.getFarmStatus()',
      'gameCtl.getGridState(path)',
      'gameCtl.summarizeAllGrids({ includePaths: true })',
      'gameCtl.findHarvestableGrids(opts)',
      'gameCtl.findMatureGrids(opts)',
      'gameCtl.findWaterableGrids(opts)',
      'gameCtl.findEraseGrassGrids(opts)',
      'gameCtl.findKillBugGrids(opts)',
      'gameCtl.findDeadGrids(opts)',
      'gameCtl.inspectOneClickToolNodes()',
      'gameCtl.getOneClickManagerState()',
      'gameCtl.triggerOneClickHarvest()',
      'gameCtl.clickMatureEffect(landId, opts)',
      'gameCtl.openLandInteraction(path)',
      'gameCtl.inspectLandDetail(opts)',
      'gameCtl.inspectFarmModelRuntime(opts)',
      'gameCtl.inspectMainUiRuntime(opts)',
      'gameCtl.inspectFarmComponentCandidates(opts)',
      'gameCtl.inspectFertilizerRuntime(opts)',
      'gameCtl.inspectProtocolTransport(opts)',
      'gameCtl.inspectRecentClickTrace(opts)',
      'gameCtl.fertilizeLand(opts)',
      'gameCtl.openLandAndDiffButtons(path, opts)',
      'gameCtl.snapshotNode(path, opts)',
      'gameCtl.tapAndSnapshot(path, opts)',
      'gameCtl.batchTap(paths, opts)',
      'gameCtl.tapFarmCandidates(keyword, opts)'
    ]
  });
})();
