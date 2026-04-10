import {
  AUTO_FARM_POLL_MS,
  DATA_TRUNCATE_LEN,
  DEFAULT_QQ_APPID,
  HEALTH_POLL_MS,
  LS_CFG_CACHE,
  LS_QQ_APPID,
  WS_PATH,
} from "./constants.js";
import { dom } from "./dom.js";
import {
  clamp,
  formatClock,
  formatDateTime,
  formatRuntimeTargetLabel,
  getConfiguredRuntimeTarget,
  getQqBundleState,
  getResolvedRuntimeTarget,
  isPreviewSupported,
  isQqAppId,
  isQqRuntimeResolved,
  normalizeText,
  setDotState,
  shortenMiddle,
} from "./utils.js";

(function () {
  const {
    logEl,
    dotWs,
    txtWs,
    dotHttp,
    txtHttp,
    dotRuntime,
    txtRuntime,
    dotGameSide,
    txtGameSide,
    selFriend,
    iptFriendTarget,
    txtFriendSummary,
    txtAutoFarmState,
    logAutoFarm,
    txtRuntimeSummary,
    txtQqHostState,
    txtQqBundleState,
    txtQqTargetState,
    txtQqPatchState,
    logQqHost,
    iptQqAppId,
    toastHost,
    txtCdpState,
    txtInjectState,
    txtRuntimeNotes,
    txtPreviewState,
    txtPreviewCapability,
    imgPreview,
    previewEmpty,
    previewStage,
    autoOwnEnabled,
    autoFriendEnabled,
    autoRefreshFriendList,
    autoReturnHome,
    autoOwnIntervalSec,
    autoFriendIntervalSec,
    autoMaxFriends,
    autoEnterWaitMs,
    autoActionWaitMs,
    autoStopOnError,
    autoStopCareWhenNoExp,
    autoPlantMode,
    autoPlantSource,
    autoPlantSelectedWrap,
    autoPlantSelectedSeed,
    txtAutoPlantSeedState,
    friendMetricTotal,
    friendMetricCollectable,
    friendMetricWater,
    friendMetricGrass,
    friendMetricBug,
    btnFriends,
    btnEnterFriend,
    btnAutoSave,
    btnAutoRunOnce,
    btnAutoStart,
    btnAutoStop,
    btnAutoRefresh,
    btnAutoPlantRefreshSeeds,
    btnRuntimeRefresh,
    btnPreviewRefresh,
    btnSaveQqBundle,
    btnFindQqGame,
    btnPatchQqGame,
    btnClearLog,
    btnToggleDebug,
    tabbar,
  } = dom;

  let ws = null;
  let reqId = 0;
  let farmConfig = {};
  let friendListCache = [];
  let autoFarmState = null;
  let autoPlantSeedCatalog = null;
  let pendingAutoPlantSelectedSeedKey = "";
  let previewState = null;
  let lastPreviewFrameMeta = null;
  let previewPointer = null;
  let lastHealth = null;
  let debugMode = false;
  let qqLookupState = null;
  let qqPatchStatus = {
    type: "",
    text: "尚未执行打补丁",
  };
  const pendingTags = new Map();
  const autoInject = {
    path: "button.js",
    inFlight: false,
    injected: false,
    contextKey: "",
    attemptedContextKey: "",
    lastError: "",
    lastOkAt: "",
  };

  try {
    const cachedQqAppId = localStorage.getItem(LS_QQ_APPID);
    if (iptQqAppId) {
      iptQqAppId.value = cachedQqAppId || DEFAULT_QQ_APPID;
    }
  } catch (_) {}

  function getQqAppIdValue() {
    return normalizeText(iptQqAppId ? iptQqAppId.value : "");
  }

  function persistQqAppId() {
    try {
      const appId = getQqAppIdValue();
      if (appId) localStorage.setItem(LS_QQ_APPID, appId);
      else localStorage.removeItem(LS_QQ_APPID);
    } catch (_) {}
  }

  function showToast(message, type, durationMs) {
    if (!toastHost || !message) return;
    const toast = document.createElement("div");
    toast.className = "toast" + (type ? " " + type : "");
    toast.textContent = String(message);
    toastHost.appendChild(toast);
    requestAnimationFrame(function () {
      toast.classList.add("show");
    });
    const ttl = Math.max(1200, Number(durationMs) || 2800);
    setTimeout(function () {
      toast.classList.remove("show");
      setTimeout(function () {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 220);
    }, ttl);
  }

  function setQqPatchState(type, text) {
    qqPatchStatus = {
      type: type || "",
      text: text || "尚未执行打补丁",
    };
    if (txtQqPatchState) {
      txtQqPatchState.className = "summary-note" + (qqPatchStatus.type ? " " + qqPatchStatus.type : "");
      txtQqPatchState.textContent = qqPatchStatus.text;
    }
  }

  function getEffectiveQqTarget(bundle) {
    const inputAppId = getQqAppIdValue();
    if (inputAppId && qqLookupState && qqLookupState.appId === inputAppId) {
      return qqLookupState;
    }
    if (!bundle) return null;
    if (inputAppId && bundle.appId && bundle.appId !== inputAppId) {
      return null;
    }
    if (!bundle.targetMode && !bundle.targetPath && !bundle.targetError && !bundle.appId) {
      return null;
    }
    return {
      appId: bundle.appId || "",
      ok: !!bundle.canPatch,
      error: bundle.targetError || null,
      data: {
        appId: bundle.appId || null,
        targetMode: bundle.targetMode || null,
        targetPath: bundle.targetPath || null,
        discovery: bundle.discovery || null,
      },
    };
  }

  function maybeSeedQqAppIdFromBundle(bundle) {
    if (!iptQqAppId || !bundle || !bundle.appId) return;
    if (getQqAppIdValue()) return;
    iptQqAppId.value = String(bundle.appId);
    persistQqAppId();
  }

  function renderQqTargetState(bundle) {
    if (!txtQqTargetState) return;
    const appId = getQqAppIdValue();
    if (appId && !isQqAppId(appId)) {
      txtQqTargetState.textContent = "AppID 需为纯数字，例如 1112386029";
      return;
    }

    const targetState = getEffectiveQqTarget(bundle);
    if (targetState && targetState.data && targetState.data.targetPath) {
      const data = targetState.data;
      if (data.discovery && data.discovery.selected) {
        const selected = data.discovery.selected;
        const parts = [
          "appid " + (data.appId || targetState.appId || appId || "unknown"),
          "目录 " + (selected.versionDirName || "unknown"),
          "目标 " + shortenMiddle(data.targetPath || selected.gameJsPath),
        ];
        if (selected.lastTouchedAt) {
          parts.push("更新 " + formatDateTime(selected.lastTouchedAt));
        }
        txtQqTargetState.textContent = parts.join(" · ");
        return;
      }
      txtQqTargetState.textContent = "显式路径: " + shortenMiddle(data.targetPath);
      return;
    }

    const error = targetState && targetState.error ? targetState.error : "";
    if (error) {
      txtQqTargetState.textContent = "目标定位失败: " + error;
      return;
    }

    if (appId) {
      txtQqTargetState.textContent = "appid " + appId + " 尚未定位，可点击“查找最新版本”或直接“一键打补丁”";
      return;
    }

    if (bundle && bundle.appId) {
      txtQqTargetState.textContent = "已配置默认 appid " + bundle.appId + "，将自动扫描最新版本目录";
      return;
    }

    txtQqTargetState.textContent = "填写 AppID 后可自动查找最新 QQ 小程序 game.js";
  }

  function findQqGameTarget(options) {
    const opts = options || {};
    const appId = getQqAppIdValue();
    persistQqAppId();

    if (!appId) {
      qqLookupState = null;
      renderQqTargetState(getQqBundleState(lastHealth));
      return Promise.resolve(null);
    }

    if (!isQqAppId(appId)) {
      qqLookupState = {
        appId: appId,
        ok: false,
        data: null,
        error: "AppID 必须是纯数字",
      };
      renderQqTargetState(getQqBundleState(lastHealth));
      if (!opts.silent) appendLine("QQ AppID 格式不正确", appId);
      return Promise.resolve(null);
    }

    if (!opts.force && qqLookupState && qqLookupState.ok && qqLookupState.appId === appId) {
      renderQqTargetState(getQqBundleState(lastHealth));
      return Promise.resolve(qqLookupState.data);
    }

    return fetch("/api/qq-miniapp/find?appid=" + encodeURIComponent(appId))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok && j.data)) {
          throw new Error(j && j.error ? j.error : "lookup failed");
        }
        qqLookupState = {
          appId: appId,
          ok: true,
          data: j.data,
          error: null,
        };
        renderQqTargetState(getQqBundleState(lastHealth));
        if (!opts.silent) appendLine("已定位 QQ game.js", j.data);
        return j.data;
      })
      .catch(function (e) {
        const err = String(e && e.message ? e.message : e);
        qqLookupState = {
          appId: appId,
          ok: false,
          data: null,
          error: err,
        };
        renderQqTargetState(getQqBundleState(lastHealth));
        if (!opts.silent) appendLine("查找 QQ game.js 失败", err);
        throw e;
      });
  }

  function appendLine(msg, obj, isDebug) {
    if (isDebug && !debugMode) return;
    const entry = document.createElement("div");
    entry.className = "log-entry";
    let line = "[" + formatClock() + "] " + msg;
    if (obj !== undefined) {
      const dataStr = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      if (dataStr.length <= DATA_TRUNCATE_LEN) {
        line += "\n" + dataStr;
        entry.textContent = line;
      } else {
        const textNode = document.createTextNode(line + "\n" + dataStr.slice(0, DATA_TRUNCATE_LEN) + "...");
        entry.appendChild(textNode);
        const toggle = document.createElement("span");
        toggle.className = "log-data-toggle";
        toggle.textContent = "展开全部 (" + dataStr.length + " 字符)";
        const fullData = document.createElement("div");
        fullData.className = "log-data-full";
        fullData.textContent = dataStr;
        toggle.onclick = function () {
          const isOpen = fullData.classList.toggle("open");
          toggle.textContent = isOpen ? "收起" : "展开全部 (" + dataStr.length + " 字符)";
        };
        entry.appendChild(toggle);
        entry.appendChild(fullData);
      }
    } else {
      entry.textContent = line;
    }
    logEl.appendChild(entry);
    // 限制最多保留 300 条
    while (logEl.children.length > 300) {
      logEl.removeChild(logEl.firstChild);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function saveTextWithDialog(filename, text, mimeType) {
    const safeName = filename || "qq-miniapp-bootstrap.js";
    const type = mimeType || "text/javascript";
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: safeName,
        types: [{
          description: "JavaScript",
          accept: {
            [type]: [".js"],
          },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return "picker";
    }

    const blob = new Blob([text], { type: type + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    return "download";
  }

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + WS_PATH;
  }

  function isQuietPreviewOp(op) {
    return op === "previewDragMove";
  }

  function summarizeWsMessageForLog(data, tag) {
    if (!data || typeof data !== "object") return data;
    if (data.event === "previewFrame") return null;
    if (data.event === "previewState") {
      return {
        event: data.event,
        state: data.state ? {
          running: data.state.running,
          subscriberCount: data.state.subscriberCount,
          lastFrameAt: data.state.lastFrameAt,
          lastError: data.state.lastError,
          options: data.state.options,
        } : null,
        extra: data.extra,
      };
    }
    if (tag === "previewCapture" && data.ok && data.result) {
      return {
        id: data.id,
        ok: true,
        result: {
          ts: data.result.ts,
          mediaType: data.result.mediaType,
          meta: data.result.meta,
          options: data.result.options,
        },
      };
    }
    if ((tag === "previewStart" || tag === "previewStop" || tag === "previewStatus") && data.ok && data.result) {
      return {
        id: data.id,
        ok: true,
        result: {
          running: data.result.running,
          subscriberCount: data.result.subscriberCount,
          lastFrameAt: data.result.lastFrameAt,
          lastError: data.result.lastError,
          options: data.result.options,
        },
      };
    }
    if ((tag === "previewTap" || tag === "previewDragStart" || tag === "previewDragEnd" || tag === "previewSwipe") && data.ok && data.result) {
      const nested = data.result.result && typeof data.result.result === "object" ? data.result.result : {};
      return {
        id: data.id,
        ok: true,
        result: Object.assign({}, data.result, {
          mode: nested.mode || data.result.mode || null,
          fallbackFrom: nested.fallbackFrom || data.result.fallbackFrom || null,
        }),
      };
    }
    if (tag === "previewDragMove") {
      return null;
    }
    return data;
  }

  function send(payload, tag) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendLine("未连接，无法发送", payload);
      return false;
    }
    const id = ++reqId;
    if (tag !== undefined && tag !== null) {
      pendingTags.set(String(id), tag);
    }
    const body = Object.assign({ id: String(id) }, payload);
    if (!isQuietPreviewOp(body.op)) appendLine("→ 发送 " + (body.op || ""), body, true);
    ws.send(JSON.stringify(body));
    return true;
  }

  function buildFriendLabel(item) {
    if (!item) return "未知好友";
    const parts = [];
    parts.push(item.displayName || item.name || item.remark || ("gid=" + item.gid));
    if (item.gid != null) parts.push("gid=" + item.gid);
    if (item.level != null && !Number.isNaN(Number(item.level))) parts.push("Lv." + item.level);
    const work = item.workCounts || {};
    if ((work.collect || 0) > 0) parts.push("可摘" + work.collect);
    if ((work.water || 0) > 0) parts.push("浇水" + work.water);
    if ((work.eraseGrass || 0) > 0) parts.push("除草" + work.eraseGrass);
    if ((work.killBug || 0) > 0) parts.push("杀虫" + work.killBug);
    return parts.join(" | ");
  }

  function updateFriendMetrics(payload) {
    const counts = payload && payload.counts ? payload.counts : {};
    friendMetricTotal.textContent = String(friendListCache.length || 0);
    friendMetricCollectable.textContent = String(counts.collectableFriends || 0);
    friendMetricWater.textContent = String(counts.waterableFriends || 0);
    friendMetricGrass.textContent = String(counts.eraseGrassFriends || 0);
    friendMetricBug.textContent = String(counts.killBugFriends || 0);
  }

  function renderFriendList(payload) {
    friendListCache = payload && Array.isArray(payload.list) ? payload.list : [];
    selFriend.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = friendListCache.length ? "选择好友" : "没有可用好友";
    selFriend.appendChild(placeholder);

    friendListCache.forEach(function (item) {
      const opt = document.createElement("option");
      opt.value = String(item.gid);
      opt.textContent = buildFriendLabel(item);
      selFriend.appendChild(opt);
    });

    selFriend.disabled = friendListCache.length === 0;
    updateFriendMetrics(payload);

    const counts = payload && payload.counts ? payload.counts : {};
    const work = payload && payload.workCounts ? payload.workCounts : {};
    let msg = friendListCache.length
      ? "好友 " + friendListCache.length + " 人；可偷好友 " + (counts.collectableFriends || 0) +
        "，可帮好友 " + (
          (Number(counts.waterableFriends) || 0)
          + (Number(counts.eraseGrassFriends) || 0)
          + (Number(counts.killBugFriends) || 0)
        ) +
        "，可浇水 " + (counts.waterableFriends || 0) +
        "，可除草 " + (counts.eraseGrassFriends || 0) +
        "，可杀虫 " + (counts.killBugFriends || 0) +
        "；总地块：摘 " + (work.collect || 0) +
        " / 水 " + (work.water || 0) +
        " / 草 " + (work.eraseGrass || 0) +
        " / 虫 " + (work.killBug || 0)
      : "好友列表为空";
    if (payload && payload.refreshError) {
      msg += "；刷新错误: " + payload.refreshError;
    }
    txtFriendSummary.textContent = msg;
  }

  function applyAutoFarmConfigToForm(cfg) {
    cfg = cfg || {};
    autoOwnEnabled.checked = !!cfg.autoFarmOwnEnabled;
    autoFriendEnabled.checked = !!cfg.autoFarmFriendEnabled;
    autoRefreshFriendList.checked = cfg.autoFarmRefreshFriendList !== false;
    autoReturnHome.checked = cfg.autoFarmReturnHome !== false;
    autoOwnIntervalSec.value = cfg.autoFarmOwnIntervalSec != null ? cfg.autoFarmOwnIntervalSec : 30;
    autoFriendIntervalSec.value = cfg.autoFarmFriendIntervalSec != null ? cfg.autoFarmFriendIntervalSec : 90;
    autoMaxFriends.value = cfg.autoFarmMaxFriends != null ? cfg.autoFarmMaxFriends : 5;
    autoEnterWaitMs.value = cfg.autoFarmEnterWaitMs != null ? cfg.autoFarmEnterWaitMs : 1800;
    autoActionWaitMs.value = cfg.autoFarmActionWaitMs != null ? cfg.autoFarmActionWaitMs : 1200;
    autoStopOnError.checked = !!cfg.autoFarmStopOnError;
    autoStopCareWhenNoExp.checked = !!cfg.autoFarmStopCareWhenNoExp;
    autoPlantMode.value = normalizeAutoPlantModeValue(cfg.autoFarmPlantMode);
    autoPlantSource.value = normalizeAutoPlantSourceValue(cfg.autoFarmPlantSource, cfg.autoFarmPlantMode);
    pendingAutoPlantSelectedSeedKey = normalizeText(
      cfg.autoFarmPlantSelectedSeedKey
        || cfg.autoFarmPlantSelectedSeed
        || cfg.autoFarmPlantSelectedSeedId
        || cfg.autoFarmPlantSelectedItemId
        || cfg.autoFarmPlantSeedId
        || cfg.autoFarmPlantItemId
        || cfg.autoFarmPlantSeedName,
    );
    if (autoPlantMode.value === "selected") {
      var selectedSeedMeta = parseAutoPlantSeedKey(pendingAutoPlantSelectedSeedKey);
      if (selectedSeedMeta && selectedSeedMeta.source) {
        autoPlantSource.value = selectedSeedMeta.source;
      }
    }
    if (autoPlantSeedCatalog) {
      renderAutoPlantSelectedSeedOptions(autoPlantSeedCatalog);
    }
    syncAutoPlantControls();
  }

  function gatherAutoFarmConfig() {
    const selectedSeedKey = normalizeText(autoPlantSelectedSeed.value || pendingAutoPlantSelectedSeedKey);
    return {
      autoFarmOwnEnabled: !!autoOwnEnabled.checked,
      autoFarmFriendEnabled: !!autoFriendEnabled.checked,
      autoFarmRefreshFriendList: !!autoRefreshFriendList.checked,
      autoFarmReturnHome: !!autoReturnHome.checked,
      autoFarmOwnIntervalSec: Number(autoOwnIntervalSec.value || 30),
      autoFarmFriendIntervalSec: Number(autoFriendIntervalSec.value || 90),
      autoFarmMaxFriends: Number(autoMaxFriends.value || 5),
      autoFarmEnterWaitMs: Number(autoEnterWaitMs.value || 1800),
      autoFarmActionWaitMs: Number(autoActionWaitMs.value || 1200),
      autoFarmStopOnError: !!autoStopOnError.checked,
      autoFarmStopCareWhenNoExp: !!autoStopCareWhenNoExp.checked,
      autoFarmPlantMode: normalizeAutoPlantModeValue(autoPlantMode.value || "none"),
      autoFarmPlantSource: normalizeAutoPlantSourceValue(autoPlantSource.value || "auto", autoPlantMode.value),
      autoFarmPlantSelectedSeedKey: selectedSeedKey,
    };
  }

  function normalizeAutoPlantModeValue(value) {
    const raw = normalizeText(value);
    if (!raw) return "none";
    if (raw === "backpack_first") return "highest";
    if (raw === "buy_highest") return "highest";
    if (raw === "buy_lowest") return "lowest";
    if (raw === "specific") return "selected";
    if (raw === "highest" || raw === "lowest" || raw === "selected" || raw === "none") return raw;
    return "none";
  }

  function normalizeAutoPlantSourceValue(value, legacyMode) {
    const raw = normalizeText(value).toLowerCase();
    if (raw === "auto" || raw === "backpack" || raw === "shop") return raw;
    if (legacyMode === "backpack_first") return "backpack";
    if (legacyMode === "buy_highest" || legacyMode === "buy_lowest") return "shop";
    return "auto";
  }

  function parseAutoPlantSeedKey(value) {
    const raw = normalizeText(value);
    const match = raw.match(/^(backpack|shop):(.*)$/i);
    if (!match) return null;
    return {
      source: String(match[1]).toLowerCase(),
      id: normalizeText(match[2]),
    };
  }

  function formatAutoPlantModeLabel(mode) {
    if (mode === "highest") return "优先最高级";
    if (mode === "lowest") return "优先最低级";
    if (mode === "selected") return "指定种子";
    return "不种植";
  }

  function formatAutoPlantSourceLabel(source) {
    if (source === "backpack") return "背包";
    if (source === "shop") return "商店";
    return "自动";
  }

  function formatAutoPlantCatalogTime(value) {
    return value ? formatDateTime(value) : "";
  }

  function buildAutoPlantSeedOptionLabel(item) {
    if (!item || typeof item !== "object") return "";
    const parts = [];
    parts.push("[" + formatAutoPlantSourceLabel(item.source) + "]");
    parts.push(item.name || item.key || "未知种子");
    if (item.source === "backpack") {
      parts.push("x" + (Number(item.count) || 0));
    }
    if (item.level != null) {
      parts.push("Lv" + (Number(item.level) || 0));
    }
    if (item.source === "shop" && item.price != null) {
      parts.push("价格 " + (Number(item.price) || 0));
    }
    return parts.join(" · ");
  }

  function renderAutoPlantSelectedSeedOptions(catalog) {
    if (!autoPlantSelectedSeed) return;
    const currentValue = normalizeText(autoPlantSelectedSeed.value || pendingAutoPlantSelectedSeedKey);
    autoPlantSelectedSeed.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = catalog && catalog.counts && catalog.counts.all > 0
      ? "请选择种子"
      : "暂无可用种子";
    autoPlantSelectedSeed.appendChild(placeholder);

    function appendGroup(label, items) {
      if (!Array.isArray(items) || items.length === 0) return;
      const group = document.createElement("optgroup");
      group.label = label;
      items.forEach(function (item) {
        const option = document.createElement("option");
        option.value = item.key;
        option.textContent = buildAutoPlantSeedOptionLabel(item);
        group.appendChild(option);
      });
      autoPlantSelectedSeed.appendChild(group);
    }

    appendGroup("背包种子", catalog && catalog.backpack);
    appendGroup("商店种子", catalog && catalog.shop);

    if (currentValue) {
      autoPlantSelectedSeed.value = currentValue;
      if (autoPlantSelectedSeed.value !== currentValue) {
        const fallback = document.createElement("option");
        fallback.value = currentValue;
        fallback.textContent = "当前配置: " + currentValue;
        autoPlantSelectedSeed.appendChild(fallback);
        autoPlantSelectedSeed.value = currentValue;
      }
    }
  }

  function renderAutoPlantSeedCatalogState(catalog, errorText) {
    if (!txtAutoPlantSeedState) return;
    if (errorText) {
      txtAutoPlantSeedState.className = "summary-note error";
      txtAutoPlantSeedState.textContent = "种子目录加载失败: " + errorText;
      return;
    }
    if (!catalog) {
      txtAutoPlantSeedState.className = "summary-note";
      txtAutoPlantSeedState.textContent = "尚未读取种子目录";
      return;
    }

    const parts = [
      "背包 " + ((catalog.counts && catalog.counts.backpack) || 0) + " 种",
      "商店 " + ((catalog.counts && catalog.counts.shop) || 0) + " 种",
    ];
    if (catalog.runtimeTarget) {
      parts.push("路线 " + formatRuntimeTargetLabel(catalog.runtimeTarget));
    }
    if (catalog.fetchedAt) {
      parts.push("更新 " + formatAutoPlantCatalogTime(catalog.fetchedAt));
    }
    const errors = catalog.errors || {};
    const errorParts = [];
    if (errors.backpack) errorParts.push("背包: " + errors.backpack);
    if (errors.shop) errorParts.push("商店: " + errors.shop);

    txtAutoPlantSeedState.className = "summary-note" + (errorParts.length ? " error" : " success");
    txtAutoPlantSeedState.textContent = errorParts.length
      ? parts.join(" · ") + " · " + errorParts.join("；")
      : parts.join(" · ");
  }

  function syncAutoPlantControls() {
    const mode = normalizeAutoPlantModeValue(autoPlantMode.value);
    const selectedMode = mode === "selected";
    if (autoPlantSelectedWrap) {
      autoPlantSelectedWrap.style.display = selectedMode ? "" : "none";
    }
    autoPlantSource.disabled = mode === "none";
    autoPlantSelectedSeed.disabled = !selectedMode;
    if (selectedMode && normalizeText(autoPlantSelectedSeed.value || pendingAutoPlantSelectedSeedKey) && !autoPlantSeedCatalog) {
      loadAutoPlantSeedCatalog(true);
    }
  }

  function loadAutoPlantSeedCatalog(silent) {
    if (btnAutoPlantRefreshSeeds) {
      btnAutoPlantRefreshSeeds.disabled = true;
      btnAutoPlantRefreshSeeds.textContent = "刷新中...";
    }
    return fetch("/api/auto-farm/seeds")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.data) {
          autoPlantSeedCatalog = j.data;
          renderAutoPlantSelectedSeedOptions(autoPlantSeedCatalog);
          renderAutoPlantSeedCatalogState(autoPlantSeedCatalog, "");
          syncAutoPlantControls();
        } else {
          autoPlantSeedCatalog = null;
          renderAutoPlantSelectedSeedOptions(null);
          renderAutoPlantSeedCatalogState(null, (j && j.error) || "未知错误");
          if (!silent) {
            appendLine("种子目录加载失败", j);
          }
        }
        return j;
      })
      .catch(function (e) {
        autoPlantSeedCatalog = null;
        renderAutoPlantSelectedSeedOptions(null);
        renderAutoPlantSeedCatalogState(null, String(e));
        if (!silent) {
          appendLine("种子目录加载失败", String(e));
        }
      })
      .finally(function () {
        if (btnAutoPlantRefreshSeeds) {
          btnAutoPlantRefreshSeeds.disabled = false;
          btnAutoPlantRefreshSeeds.textContent = "刷新种子目录";
        }
      });
  }

  function formatFarmTypeLabel(farmType) {
    if (farmType === "own") return "自己农场";
    if (farmType === "friend") return "好友农场";
    if (farmType === "unknown") return "未知农场";
    return farmType ? String(farmType) : "未知农场";
  }

  function formatActionLabel(key) {
    if (key === "collect") return "一键收获";
    if (key === "water") return "一键浇水";
    if (key === "eraseGrass") return "一键除草";
    if (key === "killBug") return "一键杀虫";
    return key ? String(key) : "未知动作";
  }

  function formatCareActionLabel(key) {
    if (key === "water") return "浇水";
    if (key === "eraseGrass") return "除草";
    if (key === "killBug") return "杀虫";
    return key ? String(key) : "打理";
  }

  function formatAutoPlantReason(reason) {
    const map = {
      not_own_farm: "当前不在自己农场",
      selected_seed_required: "未选择指定种子",
      selected_seed_not_found: "未找到指定种子",
      selected_seed_not_found_in_backpack: "背包中未找到指定种子",
      selected_seed_not_found_in_shop: "商店中未找到指定种子",
      no_seeds_in_backpack: "背包没有可用种子",
      no_seeds_in_shop: "商店没有可用种子",
      no_seed_available: "没有可用种子",
      no_seed_resolved: "没有解析出可种植种子",
      buy_failed: "购买失败",
      shop_data_error: "商店数据读取失败",
      seed_catalog_error: "种子目录读取失败",
      seed_resolution_failed_in_backpack: "背包选种失败",
      shop_seed_goods_id_missing: "商店种子缺少 goodsId",
      seed_not_found: "未找到该种子",
      seed_count_empty: "种子数量不足",
      land_not_found: "目标地块不存在",
      land_not_empty: "目标地块不是空地",
      multi_land_seed_requires_multi_land_request: "该作物需要多地块种植",
      multi_land_ids_insufficient: "多地块种植所需空地不足",
      multi_land_target_not_empty: "多地块目标里存在非空地",
      plant_timeout: "种植后等待状态更新超时",
      timeout: "操作超时",
      planted: "已种下",
    };
    return map[reason] || (reason ? String(reason) : "未知错误");
  }

  function formatAutoPlantCatalogErrors(errors) {
    const src = errors && typeof errors === "object" ? errors : {};
    const parts = [];
    if (src.backpack) parts.push("背包: " + src.backpack);
    if (src.shop) parts.push("商店: " + src.shop);
    return parts.join("；");
  }

  function collectAutoPlantFailureSamples(pr) {
    const plant = pr && pr.plantResult ? pr.plantResult : null;
    const results = Array.isArray(plant && plant.results) ? plant.results : [];
    return results
      .filter(function (item) { return !!(item && !item.ok); })
      .slice(0, 5)
      .map(function (item) {
        const reason = item.reason || (item.verify && item.verify.reason) || item.error || "";
        return {
          landId: item.landId != null
            ? item.landId
            : (Array.isArray(item.landIds) && item.landIds.length > 0 ? item.landIds.join(",") : null),
          reason: formatAutoPlantReason(reason),
          rawReason: reason || null,
          beforeStage: item.before && item.before.stageKind ? item.before.stageKind : null,
          afterStage: item.after && item.after.stageKind ? item.after.stageKind : null,
        };
      });
  }

  function buildAutoPlantDiagnosticPayload(pr) {
    const plant = pr && pr.plantResult ? pr.plantResult : null;
    const reason = pr && (pr.reason || (plant && plant.reason) || (pr.buyResult && pr.buyResult.reason) || pr.error || "");
    return {
      ok: !!(pr && pr.ok),
      mode: pr && pr.mode ? formatAutoPlantModeLabel(pr.mode) : null,
      source: pr && (pr.seedSource || pr.source) ? formatAutoPlantSourceLabel(pr.seedSource || pr.source) : null,
      emptyCount: pr && pr.emptyCount != null ? pr.emptyCount : null,
      seedName: pr && (pr.seedName || (pr.targetSeed && pr.targetSeed.name) || null),
      seedId: pr && pr.seedId != null ? pr.seedId : (pr && pr.targetSeed ? (pr.targetSeed.seedId ?? pr.targetSeed.itemId ?? null) : null),
      selectedSeedKey: pr && pr.selectedSeedKey ? pr.selectedSeedKey : null,
      reason: reason || null,
      reasonText: reason ? formatAutoPlantReason(reason) : null,
      catalogCounts: pr && pr.catalogCounts ? pr.catalogCounts : null,
      catalogErrors: pr && pr.catalogErrors ? pr.catalogErrors : null,
      buy: pr && pr.buyResult ? {
        ok: !!pr.buyResult.ok,
        reason: pr.buyResult.reason || null,
        reasonText: pr.buyResult.reason ? formatAutoPlantReason(pr.buyResult.reason) : null,
        count: pr.buyResult.count != null ? pr.buyResult.count : null,
        itemId: pr.buyResult.itemId != null ? pr.buyResult.itemId : null,
      } : null,
      plant: plant ? {
        ok: !!plant.ok,
        action: plant.action || null,
        reason: plant.reason || null,
        reasonText: plant.reason ? formatAutoPlantReason(plant.reason) : null,
        plantedCount: plant.plantedCount != null ? plant.plantedCount : null,
        failedCount: plant.failedCount != null ? plant.failedCount : null,
        requestedLandIds: plant.requestedLandIds || plant.landIds || null,
        attemptedLandIds: plant.attemptedLandIds || null,
        skippedLandIds: plant.skippedLandIds || null,
      } : null,
    };
  }

  function appendAutoPlantActionDiagnostics(action, state) {
    if (action !== "runOnce" || !state) return;
    const result = state.lastResult && state.lastResult.result ? state.lastResult.result : null;
    const own = result && result.ownFarm ? result.ownFarm : null;
    const pr = own && own.plantResult ? own.plantResult : null;
    if (!pr) return;

    appendLine("自动种植诊断", buildAutoPlantDiagnosticPayload(pr));

    const catalogErrorText = formatAutoPlantCatalogErrors(pr.catalogErrors);
    if (catalogErrorText) {
      appendLine("自动种植目录错误", catalogErrorText);
    }

    if (pr.buyResult && !pr.buyResult.ok) {
      appendLine("自动种植购买失败", pr.buyResult);
    }

    const failures = collectAutoPlantFailureSamples(pr);
    if (failures.length > 0) {
      appendLine("自动种植失败地块", failures);
    }
  }

  function formatStageCounts(stageCounts) {
    const src = stageCounts && typeof stageCounts === "object" ? stageCounts : {};
    const defs = [
      ["mature", "成熟"],
      ["growing", "生长中"],
      ["empty", "空地"],
      ["dead", "枯萎"],
      ["other", "其他"],
      ["unknown", "未知"],
      ["error", "异常"],
    ];
    const parts = [];
    defs.forEach(function (def) {
      const value = Number(src[def[0]]) || 0;
      if (value > 0) {
        parts.push(def[1] + value);
      }
    });
    return parts.join("，");
  }

  function formatWorkCounts(workCounts) {
    const src = workCounts && typeof workCounts === "object" ? workCounts : {};
    const defs = [
      ["collect", "可收"],
      ["water", "待浇水"],
      ["eraseGrass", "待除草"],
      ["killBug", "待杀虫"],
    ];
    const parts = [];
    defs.forEach(function (def) {
      const value = Number(src[def[0]]) || 0;
      if (value > 0) {
        parts.push(def[1] + value);
      }
    });
    return parts.join("，");
  }

  function formatFarmSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return "无状态信息";
    const parts = [];
    if (snapshot.farmType) parts.push(formatFarmTypeLabel(snapshot.farmType));
    if (snapshot.totalGrids != null) parts.push("总地块 " + snapshot.totalGrids);
    const stageText = formatStageCounts(snapshot.stageCounts);
    const workText = formatWorkCounts(snapshot.workCounts);
    if (stageText) parts.push("阶段: " + stageText);
    if (workText) parts.push("待处理: " + workText);
    return parts.join("，") || "无状态信息";
  }

  function formatFriendName(friend) {
    if (!friend || typeof friend !== "object") return "未知好友";
    const name = friend.displayName || friend.name || friend.remark || (friend.gid != null ? "gid=" + friend.gid : "未知好友");
    return friend.gid != null ? name + " (gid=" + friend.gid + ")" : name;
  }

  function buildAutoFarmLogLines(state) {
    const lines = [];
    if (!state) return ["暂无日志"];

    // 最近一轮结果 — 精简为每个动作一行
    var lr = state.lastResult;
    var result = lr && lr.result ? lr.result : null;
    if (result) {
      var ts = result.startedAt ? "[" + formatDateTime(result.startedAt) + "] " : "";

      // 自己农场
      var own = result.ownFarm;
      if (own && own.tasks) {
        var actions = Array.isArray(own.tasks.actions) ? own.tasks.actions : [];
        if (actions.length === 0) {
          if (state.careExpLimitState && own.tasks.careMode === "batch_land_exp_check") {
            lines.push(ts + "自己农场：共享经验已满，今日打理跳过");
          } else {
            lines.push(ts + "自己农场：无待处理项");
          }
        }
        actions.forEach(function (a) {
          if (!a) return;
          var label = a.mode === "batch_land_exp_check"
            ? ("整批" + formatCareActionLabel(a.key))
            : formatActionLabel(a.key);
          if (a.ok) {
            var extra = [];
            if (a.mode === "batch_land_exp_check") {
              extra.push("请求 " + (a.requestCount || 0) + " 次");
              extra.push("本次地块 " + (a.batchSize || 0));
              extra.push("处理 " + (a.processedCount || 0) + "/" + (a.plannedCount || 0));
              if (a.expLimitReached) {
                extra.push("整批后无经验，判定到顶");
              }
            }
            lines.push(ts + "自己农场 " + label + "：" + (a.beforeCount || 0) + " → " + (a.afterCount || 0) + (extra.length ? "，" + extra.join("，") : ""));
          } else {
            var reason = a.error || a.reason || "";
            lines.push(ts + "自己农场 " + label + "：失败 " + reason);
          }
        });
        if (own.tasks.careExpLimitReached) {
          var careInfo = own.tasks.careExpLimitInfo || {};
          lines.push(ts + "共享经验上限：已触发，暂停后续打理" + (careInfo.landId != null ? "（地块" + careInfo.landId + "）" : ""));
        }
      }

      // 自动种植
      var pr = own && own.plantResult;
      if (pr) {
        if (pr.ok && pr.action === "no_empty_lands") {
          lines.push(ts + "自动种植：无空地");
        } else if (pr.ok && pr.action === "skip") {
          // 不显示
        } else if (pr.ok) {
          var plant = pr.plantResult || {};
          var plantedCount = plant.plantedCount != null ? plant.plantedCount : (pr.emptyCount || 0);
          var failedCount = plant.failedCount != null ? plant.failedCount : 0;
          var seedLabel = pr.seedName || pr.seedId || "未知种子";
          var detailParts = [
            seedLabel,
            "模式 " + formatAutoPlantModeLabel(pr.mode),
            "来源 " + formatAutoPlantSourceLabel(pr.seedSource || pr.source),
            "空地 " + (pr.emptyCount || 0),
            "成功 " + plantedCount,
          ];
          if (failedCount > 0) {
            detailParts.push("失败 " + failedCount);
          }
          if (pr.buyResult && pr.buyResult.ok) {
            detailParts.push("已购买 " + (pr.buyResult.count || pr.emptyCount || 0));
          }
          lines.push(ts + "自动种植：" + detailParts.join(" · "));
          var successCatalogErrors = formatAutoPlantCatalogErrors(pr.catalogErrors);
          if (successCatalogErrors) {
            lines.push(ts + "自动种植目录：" + successCatalogErrors);
          }
          var successFailures = collectAutoPlantFailureSamples(pr);
          if (successFailures.length > 0) {
            lines.push(ts + "自动种植失败地块：" + successFailures.map(function (item) {
              return (item.landId != null ? ("地块" + item.landId) : "未知地块") + " " + item.reason;
            }).join("；"));
          }
        } else if (!pr.ok) {
          var failure = formatAutoPlantReason(pr.reason || (pr.plantResult && pr.plantResult.reason) || pr.error || "");
          lines.push(ts + "自动种植：失败 " + failure);
          if (pr.seedName || (pr.targetSeed && pr.targetSeed.name)) {
            lines.push(ts + "自动种植目标：" + (pr.seedName || (pr.targetSeed && pr.targetSeed.name)));
          }
          var failureCatalogErrors = formatAutoPlantCatalogErrors(pr.catalogErrors);
          if (failureCatalogErrors) {
            lines.push(ts + "自动种植目录：" + failureCatalogErrors);
          }
          if (pr.buyResult && !pr.buyResult.ok) {
            lines.push(ts + "自动种植购买：失败 " + formatAutoPlantReason(pr.buyResult.reason || "timeout"));
          }
          var failureSamples = collectAutoPlantFailureSamples(pr);
          if (failureSamples.length > 0) {
            lines.push(ts + "自动种植失败地块：" + failureSamples.map(function (item) {
              return (item.landId != null ? ("地块" + item.landId) : "未知地块") + " " + item.reason;
            }).join("；"));
          }
        }
      }

      // 好友农场
      var fs = result.friendSteal;
      if (fs) {
        var visits = Array.isArray(fs.visits) ? fs.visits : [];
        if (visits.length === 0 && (fs.actionableCandidates || 0) === 0) {
          lines.push(ts + "好友农场：无可偷/可帮好友");
        }
        visits.forEach(function (v) {
          if (!v) return;
          var name = v.friend ? (v.friend.displayName || v.friend.name || v.friend.gid) : "?";
          if (!v.ok) {
            lines.push(ts + "好友 " + name + "：" + (v.error || v.reason || "失败"));
          } else if (v.reason === "no_actionable_after_enter") {
            lines.push(ts + "好友 " + name + "：进场后无可偷/可帮，跳过");
          } else if (v.reason === "special_collect_only") {
            lines.push(ts + "好友 " + name + "：仅补收特效成熟地块");
          } else {
            var actionTexts = [];
            var friendActions = Array.isArray(v.tasks && v.tasks.actions) ? v.tasks.actions : [];
            friendActions.forEach(function (a) {
              if (!a || !a.ok) return;
              if (a.key === "collect") {
                actionTexts.push("摘取 " + (a.beforeCount || 0) + " → " + (a.afterCount || 0));
                return;
              }
              actionTexts.push(formatCareActionLabel(a.key) + " " + (a.beforeCount || 0) + " → " + (a.afterCount || 0));
            });
            lines.push(ts + "好友 " + name + "：" + (actionTexts.length ? actionTexts.join("，") : "已访问"));
            if (v.tasks && v.tasks.careExpLimitReached) {
              lines.push(ts + "好友帮助经验上限：已触发，暂停后续打理");
            }
          }
        });
      }
    }

    // 调度事件
    var events = Array.isArray(state.recentEvents) ? state.recentEvents.slice(-15).reverse() : [];
    events.forEach(function (item) {
      if (!item) return;
      var t = item.time ? "[" + formatDateTime(item.time) + "] " : "";
      var msg = item.message || "";
      if (msg === "自动化已启动") lines.push(t + "已启动");
      else if (msg.indexOf("自动化已停止:") === 0) lines.push(t + "已停止：" + msg.replace(/^自动化已停止:\s*/, ""));
      else if (msg.indexOf("执行完成:") === 0) {
        var ex = item.extra || {};
        lines.push(t + "完成 自己" + (ex.ownActions || 0) + "动作 好友" + (ex.friendVisits || 0) + "次");
      }
      else if (msg.indexOf("执行失败:") === 0) lines.push(t + "失败：" + msg.replace(/^执行失败:\s*/, ""));
      else if (msg.indexOf("调度异常:") === 0) lines.push(t + "异常：" + msg.replace(/^调度异常:\s*/, ""));
      else lines.push(t + msg);
    });

    return lines.length ? lines : ["暂无日志"];
  }

  function renderAutoFarmState(state, syncForm) {
    autoFarmState = state || null;
    if (syncForm && state && state.config) {
      applyAutoFarmConfigToForm(state.config);
    }

    if (!state) {
      txtAutoFarmState.textContent = "未加载自动化状态";
      logAutoFarm.textContent = "";
      return;
    }

    const parts = [];
    parts.push(state.running ? "运行中" : "已停止");
    if (state.runtime && state.runtime.resolvedTarget) {
      parts.push("路线: " + formatRuntimeTargetLabel(state.runtime.resolvedTarget));
    }
    if (state.busy) parts.push("执行中");
    if (state.nextRunAt) parts.push("下次: " + formatDateTime(state.nextRunAt));
    if (state.lastFinishedAt) parts.push("上次完成: " + formatDateTime(state.lastFinishedAt));
    if (state.lastError) parts.push("最近错误: " + state.lastError);
    if (state.careExpLimitState && state.careExpLimitState.dateKey) {
      parts.push(
        (state.careExpLimitState.sourceLabel || "打理") + "经验已满: " + state.careExpLimitState.dateKey,
      );
    }
    txtAutoFarmState.textContent = parts.join(" · ");
    logAutoFarm.textContent = buildAutoFarmLogLines(state).join("\n");
  }

  function gatherPreviewOptions() {
    return {
      format: "jpeg",
      maxWidth: 720,
      maxHeight: 1280,
      quality: 60,
      everyNthFrame: 2,
    };
  }

  function getPreviewSourceSize() {
    const meta = lastPreviewFrameMeta || (previewState && previewState.lastFrameMeta) || null;
    const width = meta && Number(meta.width) > 0 ? Number(meta.width) : Number(imgPreview.naturalWidth || 0);
    const height = meta && Number(meta.height) > 0 ? Number(meta.height) : Number(imgPreview.naturalHeight || 0);
    if (!(width > 0 && height > 0)) return null;
    return { width: width, height: height };
  }

  function getPreviewRenderSize() {
    const width = Number(imgPreview.naturalWidth || 0);
    const height = Number(imgPreview.naturalHeight || 0);
    if (width > 0 && height > 0) {
      return { width: width, height: height };
    }
    return getPreviewSourceSize();
  }

  function getPreviewContentRect() {
    const rect = imgPreview.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const render = getPreviewRenderSize();
    if (!render) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }
    const boxAspect = rect.width / rect.height;
    const imageAspect = render.width / render.height;
    let width = rect.width;
    let height = rect.height;
    if (imageAspect > boxAspect) {
      height = rect.width / imageAspect;
    } else {
      width = rect.height * imageAspect;
    }
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width: width,
      height: height,
    };
  }

  function mapPreviewClientPointToSource(clientX, clientY, allowClamp) {
    const rect = getPreviewContentRect();
    if (!rect || !(rect.width > 0 && rect.height > 0)) {
      return { ok: false, reason: "预览尺寸无效，无法发送操作" };
    }
    const source = getPreviewSourceSize();
    if (!source) {
      return { ok: false, reason: "缺少画面尺寸信息，无法发送操作" };
    }
    const inside =
      clientX >= rect.left &&
      clientX <= rect.left + rect.width &&
      clientY >= rect.top &&
      clientY <= rect.top + rect.height;
    if (!inside && !allowClamp) {
      return { ok: false, reason: "点击到了预览留白区，未发送操作" };
    }
    const rx = clamp((clientX - rect.left) / rect.width, 0, 1);
    const ry = clamp((clientY - rect.top) / rect.height, 0, 1);
    return {
      ok: true,
      point: {
        x: Math.max(0, Math.min(source.width - 1, Math.round(rx * source.width))),
        y: Math.max(0, Math.min(source.height - 1, Math.round(ry * source.height))),
      },
    };
  }

  function setPreviewFrame(frame) {
    if (!frame || !frame.data || !frame.mediaType) return;
    lastPreviewFrameMeta = frame.meta || lastPreviewFrameMeta;
    imgPreview.src = "data:" + frame.mediaType + ";base64," + frame.data;
    imgPreview.style.display = "block";
    previewEmpty.style.display = "none";
  }

  function renderPreviewState(state, syncForm) {
    previewState = state || null;
    if (state && state.lastFrameMeta) {
      lastPreviewFrameMeta = state.lastFrameMeta;
    }
    if (!isPreviewSupported(lastHealth)) {
      if (txtPreviewState) {
        txtPreviewState.textContent = "当前运行时不提供预览";
      }
      return;
    }
    if (!state) {
      if (txtPreviewState) {
        txtPreviewState.textContent = isPreviewSupported(lastHealth)
          ? "未加载预览状态"
          : "当前运行时不提供预览";
      }
      return;
    }
    const parts = [];
    parts.push(state.running ? "预览运行中" : "预览已停止");
    parts.push("订阅连接: " + (state.subscriberCount || 0));
    if (state.lastFrameAt) parts.push("最后一帧: " + formatDateTime(state.lastFrameAt));
    if (state.lastError) parts.push("错误: " + state.lastError);
    if (txtPreviewState) txtPreviewState.textContent = parts.join(" · ");
  }

  function handleWsEvent(data) {
    if (!data || typeof data !== "object") return false;
    if (data.event === "previewFrame") {
      setPreviewFrame(data);
      return true;
    }
    if (data.event === "previewState") {
      renderPreviewState(data.state, true);
      return true;
    }
    return false;
  }

  function clearPreviewPointer() {
    if (previewPointer && previewPointer.endTimer) {
      clearTimeout(previewPointer.endTimer);
    }
    previewPointer = null;
  }

  function handlePreviewPointerDown(ev) {
    if (previewPointer) return;
    if (ev.button != null && ev.button !== 0) return;
    if (!imgPreview.src) {
      if (txtPreviewState) txtPreviewState.textContent = "还没有预览画面，无法发送操作";
      return;
    }
    const mapped = mapPreviewClientPointToSource(ev.clientX, ev.clientY, false);
    if (!mapped.ok) {
      if (txtPreviewState) txtPreviewState.textContent = mapped.reason;
      return;
    }
    ev.preventDefault();
    try {
      if (typeof imgPreview.setPointerCapture === "function") {
        imgPreview.setPointerCapture(ev.pointerId);
      }
    } catch (_) {}
    previewPointer = {
      pointerId: ev.pointerId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startPoint: mapped.point,
      startedAt: Date.now(),
      lastPoint: mapped.point,
      moved: false,
      lastSentMoveAt: 0,
      moveSeq: 0,
      endTimer: null,
    };
    if (txtPreviewState) txtPreviewState.textContent = "手势开始: (" + mapped.point.x + ", " + mapped.point.y + ")";
    send({
      op: "previewDragStart",
      x: mapped.point.x,
      y: mapped.point.y,
    }, "previewDragStart");
  }

  function handlePreviewPointerMove(ev) {
    if (!previewPointer || ev.pointerId !== previewPointer.pointerId) return;
    ev.preventDefault();
    const mapped = mapPreviewClientPointToSource(ev.clientX, ev.clientY, true);
    if (!mapped.ok) return;
    previewPointer.lastPoint = mapped.point;
    const dxClient = ev.clientX - previewPointer.startClientX;
    const dyClient = ev.clientY - previewPointer.startClientY;
    const distClient = Math.hypot(dxClient, dyClient);
    if (distClient >= 8) {
      previewPointer.moved = true;
    }
    if (!previewPointer.moved) {
      return;
    }
    const now = Date.now();
    if (now - previewPointer.lastSentMoveAt < 16) {
      return;
    }
    previewPointer.lastSentMoveAt = now;
    previewPointer.moveSeq += 1;
    send({
      op: "previewDragMove",
      x: mapped.point.x,
      y: mapped.point.y,
      seq: previewPointer.moveSeq,
    }, "previewDragMove");
  }

  function finishPreviewPointer(ev, cancelled) {
    if (!previewPointer || ev.pointerId !== previewPointer.pointerId) return;
    const gesture = previewPointer;
    try {
      if (typeof imgPreview.releasePointerCapture === "function") {
        imgPreview.releasePointerCapture(ev.pointerId);
      }
    } catch (_) {}
    if (cancelled) {
      clearPreviewPointer();
      if (txtPreviewState) txtPreviewState.textContent = "手势已取消，正在清理触摸状态";
      send({
        op: "previewDragEnd",
        x: gesture.lastPoint.x,
        y: gesture.lastPoint.y,
      }, "previewDragEnd");
      return;
    }
    const mapped = mapPreviewClientPointToSource(ev.clientX, ev.clientY, true);
    if (!mapped.ok) {
      clearPreviewPointer();
      if (txtPreviewState) txtPreviewState.textContent = mapped.reason;
      return;
    }
    gesture.lastPoint = mapped.point;
    const minHold = 32;
    const elapsed = Date.now() - gesture.startedAt;
    const finalize = function () {
      const label = gesture.moved ? "正在结束实时滑动" : "正在结束点击";
      if (txtPreviewState) txtPreviewState.textContent = label + ": (" + gesture.lastPoint.x + ", " + gesture.lastPoint.y + ")";
      send({
        op: "previewDragEnd",
        x: gesture.lastPoint.x,
        y: gesture.lastPoint.y,
      }, "previewDragEnd");
    };
    if (!gesture.moved && elapsed < minHold) {
      gesture.endTimer = setTimeout(function () {
        clearPreviewPointer();
        finalize();
      }, minHold - elapsed);
    } else {
      clearPreviewPointer();
      finalize();
    }
  }

  function handlePreviewPointerUp(ev) {
    finishPreviewPointer(ev, false);
  }

  function handlePreviewPointerCancel(ev) {
    finishPreviewPointer(ev, true);
  }

  function loadAutoFarmState(syncForm) {
    return fetch("/api/auto-farm")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.data) {
          renderAutoFarmState(j.data, !!syncForm);
        } else {
          appendLine("自动化状态加载失败", j);
        }
        return j;
      })
      .catch(function (e) {
        appendLine("自动化状态加载失败", String(e));
      });
  }

  function sendAutoFarmAction(action) {
    const cfg = gatherAutoFarmConfig();
    Object.assign(farmConfig, cfg);
    return fetch("/api/auto-farm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action, config: cfg }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.data) {
          if (j.savedConfig) {
            farmConfig = Object.assign({}, farmConfig, j.savedConfig);
          }
          renderAutoFarmState(j.data, true);
          appendLine("自动化操作完成: " + action, j.data);
          appendAutoPlantActionDiagnostics(action, j.data);
        } else {
          appendLine("自动化操作失败: " + action, j);
        }
        return j;
      })
      .catch(function (e) {
        appendLine("自动化操作失败: " + action, String(e));
      });
  }

  function saveFarmConfigRemote() {
    fetch("/api/farm-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(farmConfig),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.ok && j.data) {
          farmConfig = j.data;
          applyAutoFarmConfigToForm(farmConfig);
          try {
            localStorage.setItem(LS_CFG_CACHE, JSON.stringify(farmConfig));
          } catch (_) {}
          appendLine("配置已保存", farmConfig);
        } else {
          appendLine("保存失败", j);
        }
      })
      .catch(function (e) {
        appendLine("保存失败", String(e));
      });
  }

  function loadFarmConfig() {
    fetch("/api/farm-config")
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.ok && j.data) {
          farmConfig = j.data;
          applyAutoFarmConfigToForm(farmConfig);
          try {
            localStorage.setItem(LS_CFG_CACHE, JSON.stringify(farmConfig));
          } catch (_) {}
        }
      })
      .catch(function () {
        try {
          const cached = localStorage.getItem(LS_CFG_CACHE);
          if (cached) {
            farmConfig = JSON.parse(cached);
            applyAutoFarmConfigToForm(farmConfig);
          }
        } catch (_) {}
      });
  }

  function setWs(ok) {
    setDotState(dotWs, ok ? "ok" : "bad");
    txtWs.textContent = ok ? "已连接 " + wsUrl() : "未连接";
  }

  function formatQqHistoryEntry(entry) {
    if (!entry || typeof entry !== "object") return "";
    const prefix = entry.time ? "[" + formatDateTime(entry.time) + "] " : "";
    if (entry.kind === "connect") {
      return prefix + "宿主已连接";
    }
    if (entry.kind === "disconnect") {
      return prefix + "宿主已断开";
    }
    if (entry.kind === "hello") {
      const payload = entry.payload || {};
      return prefix + "hello " + [
        payload.appPlatform || "unknown",
        payload.ready ? "ready" : "not_ready",
        payload.version || "?",
      ].join(" · ");
    }
    if (entry.kind === "event") {
      const payload = entry.payload || {};
      if (payload.name === "gameCtlReadyChanged") {
        return prefix + "gameCtlReady -> " + (payload.ready ? "ready" : "not_ready");
      }
      return prefix + "event " + (payload.name || "unknown");
    }
    if (entry.kind === "log") {
      const payload = entry.payload || {};
      return prefix + "[" + (payload.level || "info") + "] " + (payload.message || "");
    }
    if (entry.kind === "socketError" || entry.kind === "clientError") {
      const payload = entry.payload || {};
      return prefix + "错误: " + (payload.error || "unknown");
    }
    return prefix + (entry.kind || "unknown");
  }

  function renderRuntimeChip(payload) {
    if (!payload) {
      setDotState(dotRuntime, "warn");
      txtRuntime.textContent = "等待健康状态";
      return;
    }
    const configured = getConfiguredRuntimeTarget(payload);
    const resolved = getResolvedRuntimeTarget(payload);
    const parts = [
      "配置 " + formatRuntimeTargetLabel(configured),
      "当前 " + formatRuntimeTargetLabel(resolved),
    ];
    let state = "warn";
    if (resolved === "qq_ws") {
      state = payload.qqWs && payload.qqWs.ready ? "ok" : (payload.qqWs && payload.qqWs.connected ? "warn" : "bad");
    } else if (payload.cdp && payload.cdp.contextReady) {
      state = "ok";
    } else if (payload.cdp && payload.cdp.prepareError) {
      state = "bad";
    }
    setDotState(dotRuntime, state);
    txtRuntime.textContent = parts.join(" · ");
  }

  function renderGameSideChip(payload) {
    if (!payload) {
      setDotState(dotGameSide, "warn");
      txtGameSide.textContent = "等待健康状态";
      return;
    }
    if (isQqRuntimeResolved(payload)) {
      const qqWs = payload.qqWs || {};
      const active = Array.isArray(qqWs.clients)
        ? qqWs.clients.find(function (item) { return item.id === qqWs.activeClientId; }) || qqWs.clients[0]
        : null;
      let state = "bad";
      let text = "QQ 宿主未连接";
      if (qqWs.connected && qqWs.ready && active) {
        state = "ok";
        text = "QQ 宿主就绪 · " + (active.appPlatform || "unknown");
      } else if (qqWs.connected) {
        state = "warn";
        text = "QQ 宿主已连接，等待 gameCtl";
      }
      setDotState(dotGameSide, state);
      txtGameSide.textContent = text;
      return;
    }

    const cdp = payload.cdp || null;
    if (!payload.cdpSessionInitialized) {
      setDotState(dotGameSide, "warn");
      txtGameSide.textContent = "等待首个 CDP 会话";
      return;
    }
    if (!cdp) {
      setDotState(dotGameSide, "warn");
      txtGameSide.textContent = "CDP 会话初始化中";
      return;
    }
    const parts = [];
    if (cdp.contextReady) parts.push("上下文就绪");
    else parts.push("等待上下文");
    if (cdp.executionContextId != null) parts.push("ctx=" + cdp.executionContextId);
    let state = "warn";
    if (cdp.prepareError) {
      state = "bad";
      parts.push("错误: " + cdp.prepareError);
    } else if (cdp.contextReady) {
      state = "ok";
    } else if (cdp.transportConnected === false) {
      state = "bad";
    }
    setDotState(dotGameSide, state);
    txtGameSide.textContent = parts.join(" · ");
  }

  function getContextKey(cdp) {
    if (!cdp) return "";
    if (cdp.executionContextId != null) return "ctx:" + cdp.executionContextId;
    return "ctx:" + [
      cdp.transportConnected === true ? 1 : 0,
      cdp.contextReady === true ? 1 : 0,
      cdp.prepareState || "",
      cdp.currentJsContextId || "",
    ].join(":");
  }

  function renderInjectStatus() {
    let text = "等待上下文就绪";
    if (lastHealth && getConfiguredRuntimeTarget(lastHealth) === "qq_ws") {
      text = "QQ WS 模式无需 CDP 注入，button.js 由补丁 bundle 常驻加载";
    } else if (autoInject.inFlight) {
      text = "正在自动注入 " + autoInject.path;
    } else if (autoInject.injected) {
      text = autoInject.lastOkAt ? "已自动注入 · " + formatClock(autoInject.lastOkAt) : "已自动注入";
    } else if (autoInject.lastError) {
      text = "注入失败 · " + autoInject.lastError;
    } else if (!lastHealth || !lastHealth.cdp || !lastHealth.cdp.contextReady) {
      text = "等待上下文就绪";
    } else if (!ws || ws.readyState !== WebSocket.OPEN) {
      text = "等待浏览器 WebSocket";
    } else if (autoInject.attemptedContextKey && autoInject.attemptedContextKey === autoInject.contextKey) {
      text = "当前上下文已尝试注入";
    }
    txtInjectState.textContent = text;
  }

  function resetAutoInjectForNextContext() {
    autoInject.inFlight = false;
    autoInject.injected = false;
    autoInject.contextKey = "";
    autoInject.attemptedContextKey = "";
    autoInject.lastError = "";
    autoInject.lastOkAt = "";
  }

  function maybeAutoInjectFromHealth(payload) {
    lastHealth = payload || null;
    if (!payload || !isPreviewSupported(payload)) {
      resetAutoInjectForNextContext();
      renderInjectStatus();
      return;
    }

    const cdp = payload && payload.cdp ? payload.cdp : null;
    if (!(cdp && cdp.contextReady)) {
      if (autoInject.contextKey || autoInject.injected || autoInject.inFlight) {
        resetAutoInjectForNextContext();
      }
      renderInjectStatus();
      return;
    }

    const nextContextKey = getContextKey(cdp);
    if (autoInject.contextKey && autoInject.contextKey !== nextContextKey) {
      resetAutoInjectForNextContext();
    }
    autoInject.contextKey = nextContextKey;

    if (autoInject.inFlight || autoInject.injected || autoInject.attemptedContextKey === nextContextKey) {
      renderInjectStatus();
      return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      renderInjectStatus();
      return;
    }

    autoInject.inFlight = true;
    autoInject.lastError = "";
    autoInject.attemptedContextKey = nextContextKey;
    renderInjectStatus();
    if (!send({ op: "injectFile", path: autoInject.path }, "autoInject")) {
      autoInject.inFlight = false;
      renderInjectStatus();
    }
  }

  function renderRuntimePanel(payload) {
    if (!payload) {
      txtRuntimeSummary.textContent = "健康检查失败，等待下次轮询";
      txtQqHostState.textContent = "未连接";
      txtQqBundleState.textContent = "无法读取 bundle 配置";
      renderQqTargetState(null);
      const btnPatch0 = btnPatchQqGame;
      if (btnPatch0) btnPatch0.disabled = true;
      logQqHost.textContent = "暂无宿主日志";
      txtCdpState.textContent = "等待 CDP 状态";
      txtRuntimeNotes.textContent = "等待运行时状态";
      renderInjectStatus();
      return;
    }

    const qqWs = payload.qqWs || {};
    const active = Array.isArray(qqWs.clients)
      ? qqWs.clients.find(function (item) { return item.id === qqWs.activeClientId; }) || qqWs.clients[0]
      : null;
    const runtimeSummary = [
      "配置 " + formatRuntimeTargetLabel(getConfiguredRuntimeTarget(payload)),
      "当前 " + formatRuntimeTargetLabel(getResolvedRuntimeTarget(payload)),
      qqWs.connected ? ("QQ 宿主 " + (qqWs.ready ? "ready" : "connected")) : "QQ 宿主未连接",
    ];
    if (payload.cdp && payload.cdp.contextReady) {
      runtimeSummary.push("CDP 上下文就绪");
    } else if (payload.cdp && payload.cdp.prepareError) {
      runtimeSummary.push("CDP 错误");
    }
    txtRuntimeSummary.textContent = runtimeSummary.join(" · ");

    if (active) {
      const qqParts = [
        qqWs.ready ? "宿主已就绪" : "宿主已连接",
        active.appPlatform || "unknown",
      ];
      if (active.version) qqParts.push(active.version);
      if (active.scriptHash) qqParts.push("hash=" + active.scriptHash);
      if (Array.isArray(active.availableMethods) && active.availableMethods.length > 0) {
        qqParts.push("rpc=" + active.availableMethods.length);
      }
      txtQqHostState.textContent = qqParts.join(" · ");
    } else {
      txtQqHostState.textContent = qqWs.connected ? "宿主已连接，等待 hello" : "未连接到 QQ 宿主";
    }

    const qqLines = Array.isArray(qqWs.recentMessages)
      ? qqWs.recentMessages.slice(-18).reverse().map(formatQqHistoryEntry).filter(Boolean)
      : [];
    logQqHost.textContent = qqLines.length ? qqLines.join("\n") : "暂无宿主日志";

    const bundle = getQqBundleState(payload);
    maybeSeedQqAppIdFromBundle(bundle);
    if (bundle) {
      const bundleParts = [
        "文件 " + (bundle.defaultFilename || "qq-miniapp-bootstrap.js"),
        "ws " + (bundle.hostWsUrl || "未设置"),
        "版本 " + (bundle.hostVersion || "qq-host-1"),
      ];
      if (bundle.appId) {
        bundleParts.push("appid " + bundle.appId);
      }
      if (bundle.canPatch && bundle.targetPath) {
        bundleParts.push("可直接补丁");
      } else if (bundle.targetConfigured) {
        bundleParts.push("已配置自动定位");
      } else {
        bundleParts.push("未配置目标");
      }
      txtQqBundleState.textContent = bundleParts.join(" · ");
    } else {
      txtQqBundleState.textContent = "等待 bundle 配置";
    }
    renderQqTargetState(bundle);

    const btnPatch = btnPatchQqGame;
    if (btnPatch) {
      const appId = getQqAppIdValue();
      const canPatch = !!(bundle && bundle.canPatch) || (appId && isQqAppId(appId));
      btnPatch.disabled = !canPatch;
      btnPatch.title = btnPatch.disabled ? "填写 AppID 或配置默认目标后再使用一键打补丁" : "";
    }

    const cdp = payload.cdp || null;
    if (!isPreviewSupported(payload)) {
      txtCdpState.textContent = "当前配置为 QQ WS，CDP 不参与自动化主链路";
    } else if (!payload.cdpSessionInitialized) {
      txtCdpState.textContent = "等待首个 CDP 会话建立";
    } else if (!cdp) {
      txtCdpState.textContent = "CDP 会话初始化中";
    } else {
      const cdpParts = [];
      if (cdp.mode) cdpParts.push(cdp.mode);
      if (cdp.transportConnected === true) cdpParts.push("调试桥已连接");
      else if (cdp.transportConnected === false) cdpParts.push("调试桥未连接");
      if (cdp.contextReady) cdpParts.push("上下文就绪");
      else cdpParts.push("等待上下文");
      if (cdp.executionContextId != null) cdpParts.push("ctx=" + cdp.executionContextId);
      if (cdp.prepareError) cdpParts.push("错误: " + cdp.prepareError);
      txtCdpState.textContent = cdpParts.join(" · ");
    }

    txtRuntimeNotes.textContent = isQqRuntimeResolved(payload)
      ? "当前自动化主链路已经切到 QQ 宿主；button.js 由补丁 bundle 常驻加载。"
      : "当前自动化主链路使用 CDP；小游戏上下文重建后页面会自动补注 button.js。";
    renderInjectStatus();
  }

  function renderPreviewCapability(payload) {
    if (!payload) {
      if (txtPreviewCapability) txtPreviewCapability.textContent = "等待运行时状态";
      return;
    }

    if (!isPreviewSupported(payload)) {
      if (txtPreviewCapability) {
        txtPreviewCapability.textContent = "当前配置为 QQ WS，网关不会建立 CDP 画面预览。";
      }
      if (txtPreviewState) {
        txtPreviewState.textContent = "QQ WS 模式下不提供实时预览";
      }
      if (previewStage) {
        previewStage.classList.remove("interactive");
      }
      if (imgPreview) {
        imgPreview.style.display = "none";
        imgPreview.removeAttribute("src");
      }
      if (previewEmpty) {
        previewEmpty.style.display = "block";
        previewEmpty.textContent = "QQ WS 模式下暂无画面预览";
      }
      return;
    }

    if (previewStage) {
      previewStage.classList.add("interactive");
    }
    const cdp = payload.cdp || null;
    if (txtPreviewCapability) {
      txtPreviewCapability.textContent = cdp && cdp.contextReady
        ? "当前可以使用预览与点击/拖动输入。"
        : "预览仍走 CDP 调试桥，需等待小游戏上下文就绪。";
    }
    if (previewEmpty && !imgPreview.src) {
      previewEmpty.textContent = "等待预览...";
    }
  }

  function fetchHealth() {
    fetch("/api/health")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        lastHealth = j;
        setDotState(dotHttp, "ok");
        txtHttp.textContent = "运行中 · " + j.uptimeSec + "s";
        renderRuntimeChip(j);
        renderGameSideChip(j);
        renderRuntimePanel(j);
        renderPreviewCapability(j);
        renderPreviewState(j.preview || null, false);
        maybeAutoInjectFromHealth(j);
      })
      .catch(function () {
        lastHealth = null;
        setDotState(dotHttp, "bad");
        txtHttp.textContent = "无法访问 /api/health";
        setDotState(dotRuntime, "bad");
        txtRuntime.textContent = "健康检查失败";
        setDotState(dotGameSide, "bad");
        txtGameSide.textContent = "健康检查失败";
        renderRuntimePanel(null);
        renderPreviewCapability(null);
        renderInjectStatus();
      });
  }

  function extractDispatchMeta(payload) {
    const nested = payload && payload.result && typeof payload.result === "object" ? payload.result : null;
    return {
      mode: (payload && payload.mode) || (nested && nested.mode) || null,
      fallbackFrom: (payload && payload.fallbackFrom) || (nested && nested.fallbackFrom) || null,
    };
  }

  function handleWsResult(msg, code) {
    if (!code) return;

    if (code === "autoInject") {
      autoInject.inFlight = false;
      if (!msg.ok) {
        autoInject.injected = false;
        autoInject.lastError = msg.error || "?";
      } else {
        autoInject.injected = true;
        autoInject.lastError = "";
        autoInject.lastOkAt = new Date().toISOString();
        if (isPreviewSupported(lastHealth) && (!previewState || !previewState.running)) {
          send({ op: "previewStart", options: gatherPreviewOptions() }, "previewStart");
        }
      }
      renderInjectStatus();
      return;
    }

    if (!msg.ok) {
      const isPreviewOp =
        code === "previewStart" ||
        code === "previewStop" ||
        code === "previewCapture" ||
        code === "previewStatus" ||
        code === "previewTap" ||
        code === "previewDragStart" ||
        code === "previewDragMove" ||
        code === "previewDragEnd" ||
        code === "previewSwipe";
      if (code === "friends") {
        txtFriendSummary.textContent = "获取好友列表失败: " + (msg.error || "?");
      } else if (code === "enterFriend") {
        txtFriendSummary.textContent = "进入好友失败: " + (msg.error || "?");
      } else if (isPreviewOp) {
        if (txtPreviewState) txtPreviewState.textContent = "预览操作失败: " + (msg.error || "?");
      }
      return;
    }

    const r = msg.result;
    if (code === "friends") {
      renderFriendList(r);
      return;
    }
    if (code === "enterFriend") {
      const friend = r && r.friend ? r.friend : null;
      txtFriendSummary.textContent = friend
        ? "已发起进入好友农场: " + (friend.displayName || friend.name || friend.gid)
        : "已发起进入好友农场";
      return;
    }
    if (code === "previewStart" || code === "previewStop" || code === "previewStatus") {
      renderPreviewState(r, true);
      return;
    }
    if (code === "previewCapture") {
      setPreviewFrame(r);
      return;
    }
    if (code === "previewTap") {
      const meta0 = extractDispatchMeta(r);
      const parts0 = ["已发送点击: (" + r.x + ", " + r.y + ")"];
      if (meta0.mode) parts0.push("模式: " + meta0.mode);
      if (meta0.fallbackFrom) parts0.push("touch 回退: " + meta0.fallbackFrom);
      if (txtPreviewState) txtPreviewState.textContent = parts0.join(" · ");
      return;
    }
    if (code === "previewDragStart") {
      const meta1 = extractDispatchMeta(r);
      const parts1 = ["实时手势已开始: (" + r.x + ", " + r.y + ")"];
      if (meta1.mode) parts1.push("模式: " + meta1.mode);
      if (meta1.fallbackFrom) parts1.push("touch 回退: " + meta1.fallbackFrom);
      if (txtPreviewState) txtPreviewState.textContent = parts1.join(" · ");
      return;
    }
    if (code === "previewDragEnd") {
      const meta2 = extractDispatchMeta(r);
      const parts2 = ["实时手势已结束: (" + r.x + ", " + r.y + ")"];
      if (meta2.mode) parts2.push("模式: " + meta2.mode);
      if (meta2.fallbackFrom) parts2.push("touch 回退: " + meta2.fallbackFrom);
      if (txtPreviewState) txtPreviewState.textContent = parts2.join(" · ");
      return;
    }
    if (code === "previewSwipe") {
      const meta3 = extractDispatchMeta(r);
      const parts3 = [
        "已发送滑动: (" + r.x1 + ", " + r.y1 + ") -> (" + r.x2 + ", " + r.y2 + ")",
        "duration=" + r.durationMs + "ms",
        "steps=" + r.steps,
      ];
      if (meta3.mode) parts3.push("模式: " + meta3.mode);
      if (meta3.fallbackFrom) parts3.push("touch 回退: " + meta3.fallbackFrom);
      if (txtPreviewState) txtPreviewState.textContent = parts3.join(" · ");
    }
  }

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(wsUrl());
    ws.onopen = function () {
      setWs(true);
      appendLine("控制页 WebSocket 已连接，开始同步网关状态");
      send({ op: "ping" });
      renderInjectStatus();
      if (lastHealth) {
        maybeAutoInjectFromHealth(lastHealth);
      }
      fetchHealth();
    };
    ws.onclose = function () {
      setWs(false);
      resetAutoInjectForNextContext();
      renderInjectStatus();
      appendLine("WebSocket 断开，5 秒后重试");
      setTimeout(connect, 5000);
    };
    ws.onerror = function () {
      appendLine("WebSocket 错误");
    };
    ws.onmessage = function (ev) {
      try {
        const data = JSON.parse(ev.data);
        if (handleWsEvent(data)) return;
        const tag = data && data.id != null ? pendingTags.get(String(data.id)) : null;
        if (data && data.id != null) pendingTags.delete(String(data.id));
        const summary = summarizeWsMessageForLog(data, tag);
        if (summary !== null) appendLine("← 收到", summary, true);
        if (tag != null) {
          try {
            handleWsResult(data, tag);
          } catch (_) {}
        }
      } catch (_) {
        appendLine("← 原始", ev.data, true);
      }
    };
  }

  btnFriends.onclick = function () {
    send({
      op: "call",
      path: "gameCtl.getFriendList",
      args: [{ refresh: true }],
    }, "friends");
  };

  btnEnterFriend.onclick = function () {
    const manual = String(iptFriendTarget.value || "").trim();
    const target = manual || String(selFriend.value || "").trim();
    if (!target) {
      appendLine("请输入 gid / 名字 / 备注，或先从下拉框选择好友");
      return;
    }
    send({
      op: "call",
      path: "gameCtl.enterFriendFarm",
      args: [/^\d+$/.test(target) ? Number(target) : target],
    }, "enterFriend");
  };

  btnAutoSave.onclick = function () {
    Object.assign(farmConfig, gatherAutoFarmConfig());
    saveFarmConfigRemote();
  };

  btnAutoRunOnce.onclick = function () {
    sendAutoFarmAction("runOnce");
  };

  btnAutoStart.onclick = function () {
    sendAutoFarmAction("start");
  };

  btnAutoStop.onclick = function () {
    fetch("/api/auto-farm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.data) {
          renderAutoFarmState(j.data, false);
          appendLine("自动化已停止", j.data);
        } else {
          appendLine("停止自动化失败", j);
        }
      })
      .catch(function (e) {
        appendLine("停止自动化失败", String(e));
      });
  };

  btnAutoRefresh.onclick = function () {
    loadAutoFarmState(false);
  };

  btnAutoPlantRefreshSeeds.onclick = function () {
    loadAutoPlantSeedCatalog(false);
  };

  autoPlantMode.onchange = function () {
    syncAutoPlantControls();
    if (normalizeAutoPlantModeValue(autoPlantMode.value) === "selected") {
      loadAutoPlantSeedCatalog(true);
    }
  };

  autoPlantSource.onchange = function () {
    autoPlantSource.value = normalizeAutoPlantSourceValue(autoPlantSource.value, autoPlantMode.value);
    syncAutoPlantControls();
  };

  autoPlantSelectedSeed.onchange = function () {
    pendingAutoPlantSelectedSeedKey = normalizeText(autoPlantSelectedSeed.value);
    const parsed = parseAutoPlantSeedKey(pendingAutoPlantSelectedSeedKey);
    if (parsed && parsed.source) {
      autoPlantSource.value = parsed.source;
    }
    syncAutoPlantControls();
  };

  btnRuntimeRefresh.onclick = function () {
    fetchHealth();
    findQqGameTarget({ silent: true, force: true }).catch(function () {});
  };

  btnPreviewRefresh.onclick = function () {
    fetchHealth();
    if (isPreviewSupported(lastHealth)) {
      send({ op: "previewStatus" }, "previewStatus");
    }
  };

  btnSaveQqBundle.onclick = function () {
    fetch("/api/qq-bundle?raw=1")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        const disposition = r.headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
        return Promise.all([r.text(), Promise.resolve(match ? match[1] : "qq-miniapp-bootstrap.js")]);
      })
      .then(function (pair) {
        return saveTextWithDialog(pair[1], pair[0], "text/javascript").then(function (mode) {
          appendLine("QQ Bundle 已导出", { filename: pair[1], mode: mode });
          showToast("QQ Bundle 已导出", "success", 2200);
        });
      })
      .catch(function (e) {
        if (e && (e.name === "AbortError" || /aborted|cancelled|canceled/i.test(String(e.message || e)))) {
          appendLine("已取消保存 QQ Bundle");
          return;
        }
        appendLine("导出 QQ Bundle 失败", String(e));
      });
  };

  btnFindQqGame.onclick = function () {
    findQqGameTarget({ force: true }).catch(function () {});
  };

  btnPatchQqGame.onclick = function () {
    const btn = this;
    const prevText = btn.textContent;
    const appId = getQqAppIdValue();
    const body = {};
    if (appId && isQqAppId(appId)) {
      body.appId = appId;
    }
    btn.disabled = true;
    btn.textContent = "打补丁中...";
    setQqPatchState("", "正在打补丁，请稍候...");
    fetch("/api/qq-bundle/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok && j.data)) {
          throw new Error(j && j.error ? j.error : "patch failed");
        }
        appendLine("QQ game.js 已打补丁", j.data);
        if (j.data && j.data.target && j.data.target.appId) {
          qqLookupState = {
            appId: j.data.target.appId,
            ok: true,
            data: j.data.target,
            error: null,
          };
        }
        var patchInfo = j.data && j.data.patch ? j.data.patch : {};
        var modeText = patchInfo.replacedExistingBlock ? "已替换旧补丁区块" : "已追加新补丁区块";
        var targetText = patchInfo.targetPath ? shortenMiddle(patchInfo.targetPath, 24, 38) : "";
        var successText = "最近补丁成功 · " + formatClock() + " · " + modeText + (targetText ? " · " + targetText : "");
        setQqPatchState("success", successText);
        showToast("QQ game.js 打补丁成功，请启动qq经典农场小程序", "success", 3200);
        fetchHealth();
      })
      .catch(function (e) {
        var errText = String(e && e.message ? e.message : e);
        appendLine("QQ game.js 打补丁失败", errText);
        setQqPatchState("error", "最近补丁失败 · " + formatClock() + " · " + errText);
        showToast("QQ game.js 打补丁失败: " + errText, "error", 4200);
      })
      .finally(function () {
        btn.textContent = prevText;
        renderRuntimePanel(lastHealth);
      });
  };

  if (iptQqAppId) {
    iptQqAppId.addEventListener("change", function () {
      qqLookupState = null;
      persistQqAppId();
      renderQqTargetState(getQqBundleState(lastHealth));
      findQqGameTarget({ silent: true, force: true }).catch(function () {});
    });
    iptQqAppId.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      qqLookupState = null;
      findQqGameTarget({ force: true }).catch(function () {});
    });
  }

  btnClearLog.onclick = function () {
    logEl.innerHTML = "";
  };

  btnToggleDebug.onclick = function () {
    debugMode = !debugMode;
    this.textContent = "调试模式：" + (debugMode ? "开" : "关");
  };

  imgPreview.addEventListener("pointerdown", handlePreviewPointerDown);
  imgPreview.addEventListener("pointermove", handlePreviewPointerMove);
  imgPreview.addEventListener("pointerup", handlePreviewPointerUp);
  imgPreview.addEventListener("pointercancel", handlePreviewPointerCancel);
  imgPreview.addEventListener("dragstart", function (ev) { ev.preventDefault(); });

  tabbar.addEventListener("click", function (e) {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    const tab = btn.getAttribute("data-tab");
    document.querySelectorAll(".tab-btn").forEach(function (item) {
      item.classList.toggle("on", item === btn);
    });
    document.querySelectorAll(".panel").forEach(function (panel) {
      panel.classList.toggle("on", panel.getAttribute("data-tab") === tab);
    });
  });

  updateFriendMetrics(null);
  setWs(false);
  renderRuntimeChip(null);
  renderGameSideChip(null);
  setQqPatchState(qqPatchStatus.type, qqPatchStatus.text);
  renderRuntimePanel(null);
  renderPreviewCapability(null);
  renderInjectStatus();
  renderAutoPlantSelectedSeedOptions(null);
  renderAutoPlantSeedCatalogState(null, "");
  syncAutoPlantControls();
  if (getQqAppIdValue()) {
    findQqGameTarget({ silent: true }).catch(function () {});
  }
  connect();
  fetchHealth();
  setInterval(fetchHealth, HEALTH_POLL_MS);
  loadFarmConfig();
  loadAutoFarmState(true);
  loadAutoPlantSeedCatalog(true);
  setInterval(function () { loadAutoFarmState(false); }, AUTO_FARM_POLL_MS);
})();
