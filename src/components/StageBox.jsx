import { useMemo } from 'react';
import { scoreSykesStage } from '../lib/sykesStage';

/**
 * Compact Sykes 7-step stage card — shown near top after a symbol loads.
 */
export default function StageBox({ bars, asset, loading }) {
  const result = useMemo(
    () => scoreSykesStage(bars, { assetType: asset?.type }),
    [bars, asset?.type],
  );

  if (loading && !bars?.length) {
    return (
      <section className="stage-box stage-box--loading card" aria-busy="true">
        <p className="muted small">Reading chart for stage…</p>
      </section>
    );
  }

  if (!result.ok) {
    return (
      <section className="stage-box card" aria-label="Sykes stage">
        <div className="stage-box__row">
          <div className="stage-box__main">
            <span className="stage-box__kicker">Pattern stage</span>
            <strong className="stage-box__title">Not enough history</strong>
          </div>
          <p className="stage-box__hint muted small">
            Need ~15+ daily bars to estimate a 1–7 stage.
          </p>
        </div>
        <p className="stage-box__note muted small">
          Pattern framework only — not a buy/sell signal.
        </p>
      </section>
    );
  }

  const { stage, label, confidence, tradability, reasons } = result;
  const confClass =
    confidence === 'high'
      ? 'stage-box__conf--high'
      : confidence === 'medium'
        ? 'stage-box__conf--med'
        : 'stage-box__conf--low';

  return (
    <section
      className={`stage-box card stage-box--s${stage}`}
      aria-label={`Estimated stage ${stage}: ${label}`}
    >
      <div className="stage-box__row">
        <div className="stage-box__main">
          <span className="stage-box__kicker">Estimated stage</span>
          <div className="stage-box__title-row">
            <span className="stage-box__num" aria-hidden="true">
              {stage}
            </span>
            <strong className="stage-box__title">{label}</strong>
            <span className={`stage-box__conf ${confClass}`}>
              {confidence} confidence
            </span>
          </div>
        </div>
        <p className="stage-box__trade">{tradability}</p>
      </div>

      {reasons?.length > 0 && (
        <ul className="stage-box__chips" aria-label="Why this stage">
          {reasons.map((r) => (
            <li key={r} className="stage-box__chip">
              {r}
            </li>
          ))}
        </ul>
      )}

      <p className="stage-box__note muted small">
        Pattern framework (Sykes-style 7-step) — educational context, not advice.
      </p>
    </section>
  );
}
