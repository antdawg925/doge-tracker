// Pure: price lines for the Buy dips / Sell highs setup preview chart.
/** Chart lines for a setup: all major levels (muted), the driving level (highlighted), entry/stop/target. */
export function setupLines({ side, plan, entry, stop, target }) {
  const short = side === 'short';
  const driver = short ? plan?.resistance : plan?.support;
  const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a / b - 1) < 0.002;
  const lines = [];
  (plan?.supports || []).forEach((p, i) => {
    if (near(p, driver) || near(p, target)) return;
    lines.push({ price: p, label: `S${i + 1}`, color: '#4b5b74', style: 'dotted', muted: true });
  });
  (plan?.resistances || []).forEach((p, i) => {
    if (near(p, driver) || near(p, target)) return;
    lines.push({ price: p, label: `R${i + 1}`, color: '#4b5b74', style: 'dotted', muted: true });
  });
  if (Number.isFinite(driver)) lines.push({ price: driver, label: short ? 'R1 resistance' : 'S1 support', color: '#f5a524', style: 'solid', width: 2 });
  lines.push({ price: entry, label: short ? 'Short' : 'Buy', color: '#3d9cf0', style: 'dashed', width: 2 });
  lines.push({ price: stop, label: 'Stop', color: '#f07178', style: 'solid', width: 2 });
  lines.push({ price: target, label: short ? 'Cover' : 'T1', color: '#3ecf8e', style: 'solid', width: 2 });
  return lines;
}

