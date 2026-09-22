import { useEffect, useId, useRef, useState } from 'react';
import { searchSymbols } from '../lib/search';

/**
 * Symbol lookup — search runs only on explicit submit (Enter key or Search
 * button). Clicking a dropdown result selects; hover never loads a symbol.
 */
export default function SymbolSearch({ asset, onSelect }) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [status, setStatus] = useState(null);
  const wrapRef = useRef(null);
  const abortRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  const pick = (item) => {
    if (!item) return;
    onSelect?.({
      symbol: item.symbol,
      name: item.name,
      type: item.type,
      id: item.type === 'crypto' ? item.id : undefined,
    });
    setQuery('');
    setResults([]);
    setOpen(false);
    setActiveIdx(-1);
    setStatus(null);
    setWarnings([]);
  };

  /** Prefer exact symbol match; else single hit; else null (show list). */
  const autoPickFrom = (hits, q) => {
    if (!hits?.length) return null;
    const upper = q.trim().toUpperCase();
    const exact = hits.filter((h) => h.symbol === upper);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      // Always prefer stock/ETF over crypto when both share the ticker
      // (e.g. SPY/QQQ must not auto-pick a CoinGecko coin while on DOGE).
      return (
        exact.find((h) => h.type === 'stock') ||
        exact.find((h) => h.type === 'crypto') ||
        exact[0]
      );
    }
    if (hits.length === 1) return hits[0];
    return null;
  };

  const runSearch = async ({ preferPick = true } = {}) => {
    const q = query.trim();
    if (q.length < 1) {
      setStatus('Type a ticker or name, then press Search.');
      setResults([]);
      setOpen(false);
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setStatus(null);
    setWarnings([]);

    try {
      const { results: hits, warnings: warns } = await searchSymbols(q, {
        signal: controller.signal,
        limit: 6,
      });
      setResults(hits);
      setWarnings(warns);

      if (preferPick) {
        const auto = autoPickFrom(hits, q);
        if (auto) {
          pick(auto);
          setLoading(false);
          return;
        }
      }

      setActiveIdx(hits.length ? 0 : -1);
      setOpen(true);
      if (!hits.length) {
        setStatus('No matches — try another ticker or name.');
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setResults([]);
      setWarnings([err?.message || 'Search failed']);
      setOpen(true);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }

    if (e.key === 'ArrowDown') {
      if (!open || !results.length) return;
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!open || !results.length) return;
      e.preventDefault();
      setActiveIdx((i) => (i <= 0 ? results.length - 1 : i - 1));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // If dropdown is open with a highlighted result, pick it; else submit search
      if (open && results.length && activeIdx >= 0 && activeIdx < results.length) {
        pick(results[activeIdx]);
      } else {
        runSearch({ preferPick: true });
      }
    }
  };

  const onSubmitClick = () => {
    // Button always runs a fresh search (and auto-picks exact/single)
    runSearch({ preferPick: true });
    inputRef.current?.focus();
  };

  return (
    <div className="symbol-search" ref={wrapRef}>
      <label className="symbol-search__label" htmlFor={`${listId}-input`}>
        Find a crypto or stock
      </label>
      <div className="symbol-search__row">
        <input
          ref={inputRef}
          id={`${listId}-input`}
          className="symbol-search__input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Type DOGE, BTC, AAPL… then Search / Enter"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Typing alone must not fetch or change the loaded symbol
            setStatus(null);
          }}
          onFocus={() => {
            if (results.length) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        <button
          type="button"
          className="btn symbol-search__submit"
          onClick={onSubmitClick}
          disabled={loading}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
        <div className="symbol-search__current" title={asset?.name}>
          <span className={`chip chip--${asset?.type || 'crypto'}`}>
            {asset?.type === 'stock' ? 'Stock' : 'Crypto'}
          </span>
          <strong className="mono">{asset?.symbol}</strong>
          <span className="muted small symbol-search__name">{asset?.name}</span>
        </div>
      </div>

      {open && (results.length > 0 || status || warnings.length > 0 || loading) && (
        <div className="symbol-search__dropdown" id={listId} role="listbox">
          {loading && <div className="symbol-search__status">Searching…</div>}
          {!loading && status && (
            <div className="symbol-search__status">{status}</div>
          )}
          {warnings.length > 0 && (
            <div className="symbol-search__warn">{warnings.join(' · ')}</div>
          )}
          <ul className="symbol-search__list">
            {results.map((item, idx) => (
              <li key={`${item.type}-${item.id || item.symbol}-${idx}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === activeIdx}
                  className={`symbol-search__option${
                    idx === activeIdx ? ' is-active' : ''
                  }`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => pick(item)}
                >
                  <span className={`chip chip--${item.type}`}>
                    {item.type === 'stock' ? 'Stock' : 'Crypto'}
                  </span>
                  <span className="symbol-search__sym mono">{item.symbol}</span>
                  <span className="symbol-search__opt-name">{item.name}</span>
                  {item.exchange && (
                    <span className="muted small">{item.exchange}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="symbol-search__hint muted small">
        Press <kbd>Enter</kbd> or click Search to look up — hover won’t change the chart.
      </p>
    </div>
  );
}
