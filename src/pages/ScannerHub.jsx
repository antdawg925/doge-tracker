import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import Scanner from './Scanner';
import ShortKings from './ShortKings';
import DipBuys from './DipBuys';
import SellHighs from './SellHighs';

/**
 * One Scanner page with screen presets (former Scanner lanes + Short Kings modes).
 * Each preset keeps its own columns, filters, sort, preview, chart, fundamentals and news.
 * ?mode= wins; otherwise the last-used preset (localStorage); default Momentum.
 */
const PRESETS = [
  { id: 'momentum', label: 'Momentum' },
  { id: 'investable', label: 'Investable' },
  { id: 'dip-buys', label: 'Dip buys' },
  { id: 'sell-highs', label: 'Sell highs' },
  { id: 'short-hunt', label: 'Short hunt' },
  { id: 'my-shorts', label: 'My shorts' },
];
const KEY = 'tsb.scanner.mode';
/** Old preset ids → current ones. */
const ALIASES = { 'short-bounces': 'sell-highs' };
const valid = (m) => PRESETS.some((p) => p.id === m);
function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return valid(v) ? v : null;
  } catch {
    return null;
  }
}

export default function ScannerHub() {
  const [params, setParams] = useSearchParams();
  const rawMode = params.get('mode');
  const fromUrl = ALIASES[rawMode] || rawMode;
  const mode = valid(fromUrl) ? fromUrl : stored() || 'momentum';

  // ?mode=short-bounces → ?mode=sell-highs
  useEffect(() => {
    if (rawMode && ALIASES[rawMode]) setParams({ mode: ALIASES[rawMode] }, { replace: true });
  }, [rawMode, setParams]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* private mode */
    }
  }, [mode]);

  const pick = (id) => setParams({ mode: id }, { replace: true });
  const shorts = mode === 'short-hunt' || mode === 'my-shorts';
  const dips = mode === 'dip-buys';
  const sellHighs = mode === 'sell-highs';

  return (
    <div className="scan-hub">
      <div className="scan-hub__bar">
        <h1 className="scan-hub__title">Scanner</h1>
        <div className="scan-hub__presets" role="tablist" aria-label="Scanner preset">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={mode === p.id} className={`scan-hub__preset${mode === p.id ? ' is-active' : ''}`} onClick={() => pick(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {dips ? <DipBuys /> : sellHighs ? <SellHighs /> : shorts ? <ShortKings embedded mode={mode === 'short-hunt' ? 'hunt' : 'my-shorts'} /> : <Scanner embedded lane={mode} />}
    </div>
  );
}
