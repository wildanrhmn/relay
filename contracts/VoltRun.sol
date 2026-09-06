// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICasinoGameV2, SessionContext, SessionPhase, StepResult} from "../sdk/solidity/ICasinoGameV2.sol";

/**
 * Volt Run — the player spends a fixed budget of wires across a row of gates.
 * A gate passes if at least one of its wires survives; the round pays out on how
 * many gates the current cleared before it died.
 *
 * Every gate with k wires passes with probability exactly (2^k - 1) / 2^k, so the
 * whole outcome space is rational with denominator 2^WIRE_BUDGET and the paytable
 * needs no floating point anywhere. The multiplier is normalised per build so that
 * every legal arrangement returns exactly RTP_WAD — no configuration is better or
 * worse than another, only differently shaped.
 *
 * Mirrored by web/src/lib/voltrun.ts; the two must stay bit-for-bit identical.
 */
contract VoltRunGame is ICasinoGameV2 {
  error VoltRunGame__InvalidBuild();
  error VoltRunGame__NoPlayerAction();

  uint256 private constant WAD = 1e18;
  uint256 private constant RTP_WAD = 0.96e18;

  uint256 private constant WIRE_BUDGET = 12;
  uint256 private constant MAX_LANES = 4;
  uint256 private constant MIN_TIERS = 3;
  uint256 private constant MAX_TIERS = 12;
  uint256 private constant LANE_SCALE = 1 << MAX_LANES;

  function quoteCaps(
    uint256 wager,
    bytes calldata gameData
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    uint8[] memory lanes = _decodeBuild(gameData);
    uint256 maxPayout = _maxPayout(wager, lanes);
    maxEscrowStake = wager;
    maxReservedProfit = maxPayout > wager ? maxPayout - wager : 0;
  }

  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    returns (
      uint256 maxPayout,
      uint256 probabilityWad,
      uint256 expectedPayout,
      uint256 subJackpotVarianceScaled
    )
  {
    uint8[] memory lanes = _decodeBuild(gameData);
    maxPayout = _maxPayout(wager, lanes);
    probabilityWad = _topProbabilityWad(lanes);
    expectedPayout = (wager * RTP_WAD) / WAD;
    subJackpotVarianceScaled = 0;
  }

  function onSessionStart(SessionContext calldata ctx) external pure returns (StepResult memory stepResult) {
    uint8[] memory lanes = _decodeBuild(ctx.gameData);
    uint256 maxPayout = _maxPayout(ctx.wagerBase, lanes);

    stepResult.newGameState = abi.encode(uint8(0), uint256(0));
    stepResult.escrowDelta = 0;
    stepResult.reservedProfitDelta = int256(maxPayout > ctx.wagerBase ? maxPayout - ctx.wagerBase : 0);
    stepResult.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    stepResult.requestRandomnessNow = true;
    stepResult.payout = 0;
  }

  function onPlayerAction(SessionContext calldata, bytes calldata) external pure returns (StepResult memory) {
    revert VoltRunGame__NoPlayerAction();
  }

  function onRandomness(
    SessionContext calldata ctx,
    bytes32 randomness
  ) external pure returns (StepResult memory stepResult) {
    uint8[] memory lanes = _decodeBuild(ctx.gameData);
    uint256 depth = _resolveDepth(lanes, randomness);
    uint256 payout = (ctx.wagerBase * _multiplierWad(lanes, depth)) / WAD;

    stepResult.newGameState = abi.encode(uint8(depth), payout);
    stepResult.escrowDelta = 0;
    // Reserved profit is deliberately left untouched: the host checks the payout
    // against escrowedStake + reservedProfit before releasing either, so
    // releasing here would cap every win at the stake.
    stepResult.reservedProfitDelta = 0;
    stepResult.nextPhase = SessionPhase.SETTLED;
    stepResult.requestRandomnessNow = false;
    stepResult.payout = payout;
  }

  /// @dev Instant game: nothing is cashable mid-round, so a forfeit must quote zero.
  function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
    return 0;
  }

  function previewMultiplierWad(bytes calldata gameData, uint256 depth) external pure returns (uint256) {
    return _multiplierWad(_decodeBuild(gameData), depth);
  }

  function _decodeBuild(bytes memory gameData) private pure returns (uint8[] memory lanes) {
    lanes = abi.decode(gameData, (uint8[]));

    uint256 tiers = lanes.length;
    if (tiers < MIN_TIERS || tiers > MAX_TIERS) revert VoltRunGame__InvalidBuild();

    uint256 spent = 0;
    for (uint256 i = 0; i < tiers; i++) {
      uint256 k = lanes[i];
      if (k < 1 || k > MAX_LANES) revert VoltRunGame__InvalidBuild();
      spent += k;
    }
    if (spent != WIRE_BUDGET) revert VoltRunGame__InvalidBuild();
  }

  /// @dev Denominator of C = RTP * LANE_SCALE / laneScaleSum, the per-build normaliser.
  function _laneScaleSum(uint8[] memory lanes) private pure returns (uint256 sum) {
    sum = LANE_SCALE;
    for (uint256 i = 1; i < lanes.length; i++) sum += uint256(1) << (MAX_LANES - lanes[i]);
  }

  function _multiplierWad(uint8[] memory lanes, uint256 depth) private pure returns (uint256) {
    if (depth == 0) return 0;

    uint256 a = 1;
    uint256 s = 0;
    for (uint256 i = 0; i < depth; i++) {
      a *= (uint256(1) << lanes[i]) - 1;
      s += lanes[i];
    }

    return (RTP_WAD * LANE_SCALE * (uint256(1) << s)) / (_laneScaleSum(lanes) * a);
  }

  function _maxPayout(uint256 wager, uint8[] memory lanes) private pure returns (uint256) {
    return (wager * _multiplierWad(lanes, lanes.length)) / WAD;
  }

  function _topProbabilityWad(uint8[] memory lanes) private pure returns (uint256) {
    uint256 a = 1;
    uint256 s = 0;
    for (uint256 i = 0; i < lanes.length; i++) {
      a *= (uint256(1) << lanes[i]) - 1;
      s += lanes[i];
    }
    return (a * WAD) >> s;
  }

  /**
   * One VRF bit per wire, read most-significant first. A single bit is exactly
   * uniform over {0,1}, so this needs no rejection sampling — that requirement
   * applies when folding bytes onto a range that does not divide 256.
   */
  function _resolveDepth(uint8[] memory lanes, bytes32 randomness) private pure returns (uint256) {
    uint256 r = uint256(randomness);
    uint256 cursor = 0;

    for (uint256 i = 0; i < lanes.length; i++) {
      bool passed = false;
      for (uint256 lane = 0; lane < lanes[i]; lane++) {
        if (((r >> (255 - cursor)) & 1) == 1) passed = true;
        cursor++;
      }
      if (!passed) return i;
    }
    return lanes.length;
  }
}
