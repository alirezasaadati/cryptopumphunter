// Experimental, pure futures trade-management rules.
// This module only calculates alerts and suggested stop prices; it never places orders.
export const MANAGEMENT_CONFIG = Object.freeze({
  DEFAULT_LEVERAGE: 10,
  // Experimental R milestones. These must be validated by historical backtests
  // with fees, funding, slippage and conservative intrabar assumptions.
  STAGES: Object.freeze([
    Object.freeze({ id: "protect_075R", triggerR: 0.75, lockR: 0.10, label: "+0.75R" }),
    Object.freeze({ id: "lock_125R", triggerR: 1.25, lockR: 0.50, label: "+1.25R" }),
    Object.freeze({ id: "lock_175R", triggerR: 1.75, lockR: 1.00, label: "+1.75R" }),
    Object.freeze({ id: "lock_250R", triggerR: 2.50, lockR: 1.75, label: "+2.50R" })
  ])
});

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const direction = side => side === "LONG" ? 1 : side === "SHORT" ? -1 : 0;

export function calculateTradeProgress(trade, currentPrice, leverage = MANAGEMENT_CONFIG.DEFAULT_LEVERAGE) {
  const dir = direction(trade?.side);
  const entry = Number(trade?.actualEntry);
  const risk = Number(trade?.initialRisk);
  const price = Number(currentPrice);
  const lev = Number(leverage);

  if (!dir || !finitePositive(entry) || !finitePositive(risk) ||
      !finitePositive(price) || !finitePositive(lev)) return null;

  const favorableMove = dir * (price - entry);
  const favorableR = favorableMove / risk;
  const priceReturnPct = (favorableMove / entry) * 100;
  return {
    favorableR,
    priceReturnPct,
    leveragedRoiPct: priceReturnPct * lev,
    leverage: lev
  };
}

function stopImproves(side, proposed, current) {
  if (!finitePositive(current)) return true;
  return side === "LONG" ? proposed > current : proposed < current;
}

export function evaluateTradeManagement(
  trade,
  currentPrice,
  {
    leverage = MANAGEMENT_CONFIG.DEFAULT_LEVERAGE,
    stages = MANAGEMENT_CONFIG.STAGES
  } = {}
) {
  const progress = calculateTradeProgress(trade, currentPrice, leverage);
  if (!progress) return { valid: false, reason: "invalid_trade_or_price" };

  const side = trade.side;
  const entry = Number(trade.actualEntry);
  const risk = Number(trade.initialRisk);
  const currentStop = Number(trade.currentStop ?? trade.initialStop);
  const completed = new Set(Array.isArray(trade.managementStages) ? trade.managementStages : []);

  const reached = [...stages]
    .filter(stage => progress.favorableR >= stage.triggerR && !completed.has(stage.id))
    .sort((a, b) => b.triggerR - a.triggerR);

  for (const stage of reached) {
    const proposedStop = side === "LONG"
      ? entry + stage.lockR * risk
      : entry - stage.lockR * risk;

    // Never recommend loosening an already tighter stop.
    if (!stopImproves(side, proposedStop, currentStop)) continue;

    return {
      valid: true,
      alert: true,
      stageId: stage.id,
      stageLabel: stage.label,
      favorableR: progress.favorableR,
      leveragedRoiPct: progress.leveragedRoiPct,
      priceReturnPct: progress.priceReturnPct,
      currentStop: Number.isFinite(currentStop) ? currentStop : null,
      recommendedStop: proposedStop,
      lockedR: stage.lockR,
      leverage: progress.leverage
    };
  }

  return {
    valid: true,
    alert: false,
    favorableR: progress.favorableR,
    leveragedRoiPct: progress.leveragedRoiPct,
    priceReturnPct: progress.priceReturnPct,
    reason: reached.length ? "stop_already_tighter" : "no_new_stage"
  };
}

export function formatManagementAlert(trade, evaluation, formatPrice = value => String(value)) {
  if (!evaluation?.valid || !evaluation.alert) return null;
  const side = trade.side === "LONG" ? "لانگ" : "شورت";
  const roi = evaluation.leveragedRoiPct >= 0 ? "+" : "";
  return (
    `🛡️ هشدار هوشمند سیو سود – ${trade.symbol}\n` +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    `معامله ${side} به مرحله ${evaluation.stageLabel} رسیده است.\n` +
    `سود شناور تقریبی: ${roi}${evaluation.leveragedRoiPct.toFixed(1)}٪ با اهرم ${evaluation.leverage}x\n\n` +
    `📍 قیمت ورود: ${formatPrice(trade.actualEntry)}\n` +
    `🛑 حد ضرر فعلی: ${formatPrice(evaluation.currentStop)}\n` +
    `🔒 حد ضرر پیشنهادی جدید: ${formatPrice(evaluation.recommendedStop)}\n\n` +
    "لطفاً در صرافی حد ضرر را دستی به قیمت پیشنهادی تغییر بده. ربات سفارشی را در صرافی تغییر نمی‌دهد."
  );
}
