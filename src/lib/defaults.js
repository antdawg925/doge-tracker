/** Editable default position plan — not live brokerage data. */
export const STORAGE_KEY = 'doge-tracker-position-v1';

export const DEFAULTS = {
  accountSize: 15000,
  dogeValue: 1800,
  avgCost: 0.074,
  coreUsd: 7500,
  sleeveUsd: 2500,
  cashUsd: 5000,
  targetDogeUsd: 10000,
  targetPrice: 0.2,
};

export const BUY_LADDER = [
  {
    id: 'optional',
    label: 'Optional small add',
    low: 0.078,
    high: 0.08,
    allocateUsd: 500,
    note: 'Light add if dipping',
  },
  {
    id: 'main',
    label: 'Main add',
    low: 0.074,
    high: 0.074,
    allocateUsd: 2500,
    note: 'Primary accumulation zone',
  },
  {
    id: 'finish',
    label: 'Finish / fill',
    low: 0.07,
    high: 0.07,
    allocateUsd: 2000,
    note: 'Complete book toward target',
  },
];

export const STOP_ADDING = {
  label: 'Stop adding',
  low: 0.06,
  high: 0.067,
  note: 'Weekly break of $0.067–$0.060 — pause adds',
};

export const VOL_RULES = {
  sellLow: 0.09,
  sellHigh: 0.1,
  rebuyLow: 0.07,
  rebuyHigh: 0.074,
  invalidation: 0.067,
};

export const PN_L_LEVELS = [null, 0.074, 0.07, 0.1, 0.15, 0.2];
