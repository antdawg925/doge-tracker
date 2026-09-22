import { useEffect, useId, useRef, useState } from 'react';
import { searchSymbols } from '../lib/search';

const DEBOUNCE_MS = 280;

/**
 * Symbol lookup — typeahead suggestions while typing (debounced). Selection
 * only on click or Enter with a highlighted row; hover never loads a symbol.
 * Never auto-picks on exact match (Stock vs Crypto ambiguity).
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
  /** Skip the next debounced run when we just cleared after pick. */
  const skipDebounceRef = useRef(false);

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

  // Debounced typeahead while typing
  useEffect(() => {
    if (skipDebounceRef.current) {
      skipDebounceRef.current = false;
      return undefined;
    }

    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      setWarnings([]);
      setStatus(null);
      setLoading(false);
      setOpen(false);
      setActiveIdx(-1);
      return undefined;
    }

    setLoading(true);
    setStatus(null);
    const timer = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const { results: hits, warnings: warns } = await searchSymbols(q, {
          signal: controller.signal,
          limit: 6,
        });
        setResults(hits);
        setWarnings(warns);
        // Nothing highlighted until arrow/hover — avoids Enter auto-picking
        setActiveIdx(-1);
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
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query]);

  const pick = (item) => {
    if (!item) return;
    onSelect?.({
      symbol: item.symbol,
      name: item.name,
      type: item.type,
      id: item.type === 'crypto' ? item.id : undefined,
    });
    skipDebounceRef.current = true;
    setQuery('');
    setResults([]);
    setOpen(false);
    setActiveIdx(-1);
    setStatus(null);
    setWarnings([]);
    setLoading(false);
  };

  /** Fresh search on demand (Search button / Enter with no highlight). Never auto-picks. */
  const runSearch = async () => {
    const q = query.trim();
    if (q.length < 1) {
      setStatus('Type a ticker or name, then pick from the list.');
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
      setActiveIdx(-1);
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
      setActiveIdx(-1);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!results.length) {
        runSearch();
        return;
      }
      setOpen(true);
      setActiveIdx((i) => (i < 0 ? 0 : (i + 1) % results.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      if (!open || !results.length) return;
      e.preventDefault();
      setActiveIdx((i) =>
        i < 0 ? results.length - 1 : i <= 0 ? results.length - 1 : i - 1,
      );
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // Highlighted row → select; otherwise open/refresh list (no auto-pick)
      if (open && results.length && activeIdx >= 0 && activeIdx < results.length) {
        pick(results[activeIdx]);
      } else {
        runSearch();
      }
    }
  };

  const onSubmitClick = () => {
    runSearch();
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
          placeholder="Type DOGE, BTC, XRP, AAPL…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setStatus(null);
            setOpen(true);
          }}
          onFocus={() => {
            if (results.length || query.trim()) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIdx >= 0 ? `${listId}-opt-${activeIdx}` : undefined
          }
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

      {open &&
        (results.length > 0 || status || warnings.length > 0 || loading) && (
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
                    id={`${listId}-opt-${idx}`}
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
        Suggestions appear as you type — click or arrow+
        <kbd>Enter</kbd> to load. Hover won’t change the chart.
      </p>
    </div>
  );
}
