/**
 * Top-of-desk warning when a symbol is a known P&D or chart lookalike.
 */
export default function PumpDumpBanner({ assessment }) {
  if (!assessment?.show) return null;

  const via =
    assessment.source === 'known_list'
      ? 'Known list match'
      : assessment.source === 'chart_pattern'
        ? 'Chart-pattern lookalike'
        : 'Warning';

  const conf =
    assessment.confidence === 'high'
      ? 'High confidence'
      : assessment.confidence === 'med'
        ? 'Medium confidence'
        : null;

  return (
    <section
      className="pump-dump-banner"
      role="alert"
      aria-label="Pump and dump warning"
    >
      <div className="pump-dump-banner__mark" aria-hidden>
        !
      </div>
      <div className="pump-dump-banner__body">
        <div className="pump-dump-banner__title-row">
          <strong className="pump-dump-banner__title">{assessment.title}</strong>
          <span className="pump-dump-banner__via">{via}</span>
          {conf && <span className="pump-dump-banner__conf">{conf}</span>}
        </div>
        <p className="pump-dump-banner__detail">{assessment.detail}</p>
        {assessment.reasons?.length > 0 && (
          <ul className="pump-dump-banner__reasons">
            {assessment.reasons.slice(0, 4).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
