/**
 * Official broker/exchange logos, used unaltered as small labels (nominative use only).
 * Sources + notes: public/brands/SOURCES.md. Never recolor, crop or stretch: height only, width auto.
 */
const BRANDS = {
  schwab: { src: '/brands/schwab.svg', alt: 'Charles Schwab', ratio: 1 },
  kraken: { src: '/brands/kraken-white.svg', alt: 'Kraken', ratio: 650 / 101 },
};

export function BrandMark({ brand, height = 16, decorative = false, className = '' }) {
  const b = BRANDS[brand];
  if (!b) return null;
  return (
    <img
      src={b.src}
      alt={decorative ? '' : b.alt}
      title={decorative ? undefined : b.alt}
      height={height}
      width={Math.round(height * b.ratio)}
      className={`brand-mark brand-mark--${brand}${className ? ` ${className}` : ''}`}
      draggable="false"
    />
  );
}
