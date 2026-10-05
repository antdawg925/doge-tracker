import { useState } from 'react';

/** Segmented pill buttons under the Research chart: one section open at a time. */
const KEY = 'tsb.research.tab';
export default function ResearchTabs({ tabs, active, onChange }) {
  const [own, setOwn] = useState(() => {
    try {
      return localStorage.getItem(KEY) || tabs[0]?.id;
    } catch {
      return tabs[0]?.id;
    }
  });
  const cur = active ?? own;
  const tab = tabs.find((t) => t.id === cur) || tabs[0];
  const pick = (id) => {
    setOwn(id);
    onChange?.(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* private mode */
    }
  };
  return (
    <section className="card rtabs">
      <div className="rtabs__bar" role="tablist" aria-label="Research sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab.id} className={`rtabs__tab${t.id === tab.id ? ' is-active' : ''}${t.alert ? ' rtabs__tab--alert' : ''}`} onClick={() => pick(t.id)}>
            <span className="rtabs__label">{t.label}</span>
          </button>
        ))}
      </div>
      <div className="rtabs__panel" role="tabpanel">
        {tab?.content}
      </div>
    </section>
  );
}
