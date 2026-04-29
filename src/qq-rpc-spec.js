"use strict";

const QQ_RPC_HOST_METHODS = Object.freeze([
  "host.ping",
  "host.describe",
]);

const QQ_RPC_GAME_CTL_METHODS = Object.freeze([
  "getFarmOwnership",
  "getFarmStatus",
  "getFriendList",
  "enterOwnFarm",
  "enterFriendFarm",
  "triggerOneClickOperation",
  "clickMatureEffect",
  "dismissRewardPopup",
  "inspectRewardPopupTextMatches",
  "inspectRewardPopupTarget",
  "inspectLandDetail",
  "inspectFarmModelRuntime",
  "inspectMainUiRuntime",
  "inspectFarmComponentCandidates",
  "getPlayerProfile",
  "scanSystemAccountCandidates",
  "getWarehouseItems",
  "inspectFertilizerRuntime",
  "inspectProtocolTransport",
  "inspectRecentClickTrace",
  "fertilizeLand",
  "getSeedList",
  "requestShopData",
  "getShopGoodsList",
  "getShopSeedList",
  "inspectShopModelRuntime",
  "inspectShopUi",
  "autoReconnectIfNeeded",
  "autoPlant",
]);

const QQ_RPC_OPTIONAL_ALLOWED_PATHS = Object.freeze([
  "gameCtl.closePlantInteractionUi",
  "gameCtl.detectActiveOverlays",
  "gameCtl.dismissActiveOverlay",
  "gameCtl.fertilizeLandsBatch",
]);

const QQ_RPC_ALLOWED_PATHS = Object.freeze([
  ...QQ_RPC_HOST_METHODS,
  ...QQ_RPC_GAME_CTL_METHODS.map((name) => "gameCtl." + name),
  ...QQ_RPC_OPTIONAL_ALLOWED_PATHS,
]);

module.exports = {
  QQ_RPC_ALLOWED_PATHS,
  QQ_RPC_GAME_CTL_METHODS,
  QQ_RPC_HOST_METHODS,
  QQ_RPC_OPTIONAL_ALLOWED_PATHS,
};
