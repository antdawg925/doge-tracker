import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import Scanner from './Scanner';
import ShortKings from './ShortKings';

/**
 * One Scanner page with screen presets (former Scanner lanes + Short Kings modes).
 * Each preset keeps its own columns, filters, sort, preview, chart, fundamentals and news.
 * ?mode= wins; otherwise the last-used preset (localStorage); default Momentum.
 */
const PRESETS = [
  { id: 'momentum', label: 'Momentum' },
  { id: 'investable', label: 'Investable' },
  { id: 'short-hunt', label: 'Short hunt' },
  { id: 'my-shorts', label: 'My shorts' },
];
const KEY = 'tsb.scanner.mode';
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
  const fromUrl = params.get('mode');
  const mode = valid(fromUrl) ? fromUrl : stored() || 'momentum';

  useEffect(() => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* private mode */
    }
  }, [mode]);

  const pick = (id) => setParams({ mode: id }, { replace: true });
  const shorts = mode === 'short-hunt' || mode === 'my-shorts';

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
      {shorts ? <ShortKings embedded mode={mode === 'short-hunt' ? 'hunt' : 'my-shorts'} /> : <Scanner embedded lane={mode} />}
    </div>
  );
}
