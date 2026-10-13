/**
 * App-wide order result modal. Any ticket calls showOrderResult({...}) after a paper or live
 * order is submitted (or fails); <OrderResultModal/> (mounted once in AppLayout) shows it until closed.
 */
const EVT = 'ts-order-result';
export function showOrderResult(r) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { ...r, at: r.at || new Date().toISOString() } }));
}
export function onOrderResult(fn) {
  const h = (e) => fn(e.detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}
