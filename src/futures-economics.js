export const FUTURES_ECONOMICS = Object.freeze({
  REFERENCE_MARGIN_USD: 10,
  LEVERAGE: 10,
  MIN_PROJECTED_PROFIT_USD: 2,
  MAX_STOP_LOSS_USD: 2,
  MIN_WEIGHTED_REWARD_RISK: 2,
  EXIT_WEIGHTS: Object.freeze([0.20, 0.20, 0.60])
});

export function calculateTradeEconomics(signal, overrides = {}) {
  const config = { ...FUTURES_ECONOMICS, ...overrides };
  const values = [signal?.entry, signal?.stop, signal?.target1, signal?.target2, signal?.target3]
    .map(Number);
  if (!values.every(Number.isFinite) || values.some(x => x <= 0) ||
      !Number.isFinite(config.REFERENCE_MARGIN_USD) || config.REFERENCE_MARGIN_USD <= 0 ||
      !Number.isFinite(config.LEVERAGE) || config.LEVERAGE <= 0) return null;

  const [entry, stop, target1, target2, target3] = values;
  const direction = signal.side === "LONG" ? 1 : signal.side === "SHORT" ? -1 : 0;
  if (!direction) return null;
  const riskFraction = direction * (entry - stop) / entry;
  const targetFractions = [target1, target2, target3].map(target => direction * (target - entry) / entry);
  if (!(riskFraction > 0) || targetFractions.some(x => !(x > 0))) return null;

  const notionalUsd = config.REFERENCE_MARGIN_USD * config.LEVERAGE;
  const maxLossUsd = riskFraction * notionalUsd;
  const projectedProfitUsd = targetFractions.reduce(
    (sum, fraction, i) => sum + fraction * notionalUsd * config.EXIT_WEIGHTS[i], 0
  );
  const weightedRewardRisk = projectedProfitUsd / maxLossUsd;
  return {
    referenceMarginUsd: config.REFERENCE_MARGIN_USD,
    leverage: config.LEVERAGE,
    notionalUsd,
    maxLossUsd,
    projectedProfitUsd,
    weightedRewardRisk,
    profitOnMarginPct: projectedProfitUsd / config.REFERENCE_MARGIN_USD * 100,
    exitWeights: [...config.EXIT_WEIGHTS]
  };
}

export function qualifyTradeEconomics(economics, overrides = {}) {
  const config = { ...FUTURES_ECONOMICS, ...overrides };
  if (!economics) return { eligible: false, reason: "محاسبه سود و زیان معامله معتبر نیست." };
  if (economics.maxLossUsd > config.MAX_STOP_LOSS_USD) {
    return { eligible: false, reason: `ضرر تخمینی تا استاپ ${economics.maxLossUsd.toFixed(2)} دلار است و از سقف ${config.MAX_STOP_LOSS_USD.toFixed(2)} دلار بیشتر است.` };
  }
  if (economics.projectedProfitUsd < config.MIN_PROJECTED_PROFIT_USD) {
    return { eligible: false, reason: `سود ناخالص تخمینی با خروج پله‌ای فقط ${economics.projectedProfitUsd.toFixed(2)} دلار است؛ حداقل قابل قبول ${config.MIN_PROJECTED_PROFIT_USD.toFixed(2)} دلار به ازای ${config.REFERENCE_MARGIN_USD} دلار مارجین و لوریج ${config.LEVERAGE} است.` };
  }
  if (economics.weightedRewardRisk < config.MIN_WEIGHTED_REWARD_RISK) {
    return { eligible: false, reason: `نسبت سود وزنی به ریسک ${economics.weightedRewardRisk.toFixed(2)}R کمتر از حداقل ${config.MIN_WEIGHTED_REWARD_RISK}R است.` };
  }
  return { eligible: true, reason: null };
}
