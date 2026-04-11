"use strict";

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase();
}

function pickPositiveLevel(values) {
  const list = Array.isArray(values) ? values : [];
  let best = 0;
  for (let i = 0; i < list.length; i += 1) {
    const num = Number(list[i]);
    if (Number.isFinite(num) && num > best) best = num;
  }
  return best;
}

function getProfilePlantLevel(profile) {
  const raw = profile && typeof profile === "object" ? profile : {};
  return pickPositiveLevel([
    raw.plantLevel,
    raw.maxPlantLevel,
    raw.farmMaxLandLevel,
    raw.level,
  ]);
}

function normalizeProfile(profile) {
  const raw = profile && typeof profile === "object" ? profile : {};
  const farmMaxLandLevel = pickPositiveLevel([
    raw.farmMaxLandLevel,
    raw.maxPlantLevel,
    raw.plantLevel,
  ]);
  const plantLevel = getProfilePlantLevel(raw);
  const out = {
    gid: isFiniteNumber(raw.gid) ? Number(raw.gid) : null,
    name: normalizeText(raw.name) || null,
    level: isFiniteNumber(raw.level) ? Number(raw.level) : null,
    plantLevel: plantLevel > 0 ? plantLevel : null,
    farmMaxLandLevel: farmMaxLandLevel > 0 ? farmMaxLandLevel : null,
    exp: isFiniteNumber(raw.exp) ? Number(raw.exp) : null,
    nextLevelExp: isFiniteNumber(raw.nextLevelExp) ? Number(raw.nextLevelExp) : null,
    playerId: isFiniteNumber(raw.playerId) ? Number(raw.playerId) : null,
    gold: isFiniteNumber(raw.gold) ? Number(raw.gold) : null,
    coupon: isFiniteNumber(raw.coupon) ? Number(raw.coupon) : null,
    diamond: isFiniteNumber(raw.diamond) ? Number(raw.diamond) : null,
    bean: isFiniteNumber(raw.bean) ? Number(raw.bean) : null,
  };
  return out;
}

function isEmptyProfile(profile) {
  const cur = normalizeProfile(profile);
  const hasPositiveGid = cur.gid != null && cur.gid > 0;
  const hasMeaningfulName = !!cur.name && cur.name !== "1111";
  const hasPositiveLevel = cur.level != null && cur.level > 0;
  const hasPositiveAssets = (
    (cur.gold != null && cur.gold > 0) ||
    (cur.coupon != null && cur.coupon > 0) ||
    (cur.diamond != null && cur.diamond > 0) ||
    (cur.bean != null && cur.bean > 0)
  );
  const hasPositiveExp = cur.exp != null && cur.exp > 0;
  return !(hasPositiveGid || hasMeaningfulName || hasPositiveLevel || hasPositiveAssets || hasPositiveExp);
}

function hasIdentityFields(profile) {
  const cur = normalizeProfile(profile);
  const hasPositiveGid = cur.gid != null && cur.gid > 0;
  const hasMeaningfulName = !!cur.name && cur.name !== "1111";
  const hasPositiveLevel = cur.level != null && cur.level > 0;
  const hasPositiveGold = cur.gold != null && cur.gold > 0;
  const hasPositiveExp = cur.exp != null && cur.exp > 0;
  return Boolean(
    hasPositiveGid ||
    (hasMeaningfulName && hasPositiveLevel && hasPositiveGold) ||
    (hasMeaningfulName && hasPositiveLevel && hasPositiveExp && hasPositiveGold)
  );
}

function profileFromCandidate(candidate) {
  const picked = candidate && candidate.picked && typeof candidate.picked === "object"
    ? candidate.picked
    : {};
  return normalizeProfile({
    gid: picked.gid != null ? picked.gid : (picked.uid != null ? picked.uid : picked.playerId),
    name: picked.name != null ? picked.name : (picked.limitName != null ? picked.limitName : picked.nickname),
    level: picked.level != null ? picked.level : (picked.lv != null ? picked.lv : picked.grade),
    plantLevel: picked.plantLevel != null ? picked.plantLevel : (picked.maxPlantLevel != null ? picked.maxPlantLevel : picked.farmMaxLandLevel),
    farmMaxLandLevel: picked.farmMaxLandLevel != null ? picked.farmMaxLandLevel : (picked.maxPlantLevel != null ? picked.maxPlantLevel : picked.plantLevel),
    exp: picked.exp,
    gold: picked.gold,
    coupon: picked.coupon != null ? picked.coupon : picked.ticket,
    diamond: picked.diamond,
    bean: picked.goldenBean != null ? picked.goldenBean : picked.bean,
  });
}

function isPlaceholderCandidate(candidateProfile) {
  return (
    candidateProfile.gid === 1111 &&
    candidateProfile.name === "1111" &&
    (candidateProfile.level == null || candidateProfile.level <= 1) &&
    (candidateProfile.gold == null || candidateProfile.gold === 0) &&
    (candidateProfile.coupon == null || candidateProfile.coupon === 0) &&
    (candidateProfile.diamond == null || candidateProfile.diamond === 0) &&
    (candidateProfile.bean == null || candidateProfile.bean === 0) &&
    (candidateProfile.exp == null || candidateProfile.exp === 0)
  );
}

function isGenericRuntimeProfile(profile) {
  const cur = normalizeProfile(profile);
  const name = normalizeText(cur.name);
  if (!name) return false;
  if (name === "1111") return true;
  if (name.includes("农夫") && (name.includes("...") || name.includes("…"))) return true;
  return false;
}

function chooseBestCandidate(candidates) {
  return chooseBestCandidateWithOptions(candidates, {});
}

function chooseBestCandidateWithOptions(candidates, options) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cfg = options && typeof options === "object" ? options : {};
  const excludedGids = new Set(
    Array.isArray(cfg.excludedGids)
      ? cfg.excludedGids.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : []
  );
  let best = null;

  for (let i = 0; i < list.length; i += 1) {
    const candidate = list[i];
    const profile = profileFromCandidate(candidate);
    if (isPlaceholderCandidate(profile)) continue;
    if (profile.gid != null && excludedGids.has(profile.gid)) continue;

    let score = Number(candidate && candidate.score) || 0;
    const keys = Array.isArray(candidate && candidate.keys) ? candidate.keys : [];
    const keySet = new Set(keys);
    const hasFriendMarkers = (
      keySet.has("plant") ||
      keySet.has("rank") ||
      keySet.has("inviteTime") ||
      keySet.has("visitRefreshTime")
    );

    if (profile.level != null && profile.level >= 30) score += 3;
    if (profile.gold != null && profile.gold >= 1000000) score += 3;
    if (profile.coupon != null && profile.coupon > 0) score += 4;
    if (profile.diamond != null && profile.diamond > 0) score += 4;
    if (profile.bean != null && profile.bean > 0) score += 4;
    if (profile.exp != null && profile.exp > 0) score += 3;
    if (profile.name && normalizeName(profile.name).includes("蒙面偷菜")) score -= 20;
    if (profile.level != null && profile.level <= 1 && profile.exp === 0) score -= 6;

    if (hasFriendMarkers) score -= 6;

    if (!best || score > best.score) {
      best = {
        score,
        candidate,
        profile,
      };
    }
  }

  return best;
}

function mergeProfiles(baseProfile, overlayProfile) {
  const base = normalizeProfile(baseProfile);
  const overlay = normalizeProfile(overlayProfile);
  const plantLevel = pickPositiveLevel([
    base.plantLevel,
    base.farmMaxLandLevel,
    base.level,
    overlay.plantLevel,
    overlay.farmMaxLandLevel,
    overlay.level,
  ]);
  const farmMaxLandLevel = pickPositiveLevel([
    base.farmMaxLandLevel,
    overlay.farmMaxLandLevel,
  ]);
  return {
    gid: base.gid != null && base.gid > 0 ? base.gid : overlay.gid,
    name: base.name || overlay.name,
    level: base.level != null && base.level > 0 ? base.level : overlay.level,
    plantLevel: plantLevel > 0 ? plantLevel : null,
    farmMaxLandLevel: farmMaxLandLevel > 0 ? farmMaxLandLevel : null,
    exp: base.exp != null && base.exp > 0 ? base.exp : overlay.exp,
    nextLevelExp: base.nextLevelExp != null && base.nextLevelExp > 0 ? base.nextLevelExp : overlay.nextLevelExp,
    playerId: base.playerId != null && base.playerId > 0 ? base.playerId : overlay.playerId,
    gold: base.gold != null && base.gold > 0 ? base.gold : overlay.gold,
    coupon: overlay.coupon != null ? overlay.coupon : base.coupon,
    diamond: overlay.diamond != null ? overlay.diamond : base.diamond,
    bean: overlay.bean != null ? overlay.bean : base.bean,
  };
}

function resolveProfileWithCandidates(primaryProfile, candidatesPayload, options) {
  const directProfile = normalizeProfile(primaryProfile);
  const cfg = options && typeof options === "object" ? options : {};
  const excludedGids = new Set(
    Array.isArray(cfg.excludedGids)
      ? cfg.excludedGids.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : []
  );
  const best = chooseBestCandidateWithOptions(candidatesPayload && candidatesPayload.matches, cfg);

  if (
    best &&
    !isEmptyProfile(best.profile) &&
    isGenericRuntimeProfile(directProfile) &&
    normalizeName(best.profile.name) !== normalizeName(directProfile.name) &&
    (Number(best.profile.level) || 0) >= (Number(directProfile.level) || 0) &&
    (Number(best.profile.gold) || 0) >= (Number(directProfile.gold) || 0)
  ) {
    return {
      profile: mergeProfiles(best.profile, directProfile),
      source: "system_candidates_preferred_over_generic_runtime",
      matchedCandidate: best,
    };
  }

  if (
    !isEmptyProfile(directProfile) &&
    hasIdentityFields(directProfile) &&
    !(directProfile.gid != null && excludedGids.has(directProfile.gid))
  ) {
    return {
      profile: directProfile,
      source: "runtime",
      matchedCandidate: null,
    };
  }

  if (best && !isEmptyProfile(best.profile) && !isEmptyProfile(directProfile)) {
    return {
      profile: mergeProfiles(best.profile, directProfile),
      source: "system_candidates+runtime_assets",
      matchedCandidate: best,
    };
  }

  if (best && !isEmptyProfile(best.profile)) {
    return {
      profile: best.profile,
      source: "system_candidates",
      matchedCandidate: best,
    };
  }

  return {
    profile: directProfile,
    source: "runtime_empty",
    matchedCandidate: null,
  };
}

module.exports = {
  chooseBestCandidate,
  chooseBestCandidateWithOptions,
  getProfilePlantLevel,
  isEmptyProfile,
  normalizeProfile,
  profileFromCandidate,
  resolveProfileWithCandidates,
};
