/**
 * Shared technical-analysis helpers (pure, no TradingView access).
 */

/** EMA seeded with the SMA of the first `len` values; leading nulls in the input are skipped. */
export function ema(values, len) {
  const start = values.findIndex(v => v != null);
  const out = new Array(values.length).fill(null);
  if (start < 0) return out;
  const k = 2 / (len + 1);
  let e = null;
  for (let i = start; i < values.length; i++) {
    if (i < start + len - 1) continue;
    e = e === null ? values.slice(start, start + len).reduce((a, b) => a + b, 0) / len : values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Tillson T3: six chained EMAs combined with the volume factor v (same formula as the Pine indicator). */
export function t3(values, len, v = 0.7) {
  const e1 = ema(values, len), e2 = ema(e1, len), e3 = ema(e2, len);
  const e4 = ema(e3, len), e5 = ema(e4, len), e6 = ema(e5, len);
  const c1 = -v * v * v;
  const c2 = 3 * v * v + 3 * v * v * v;
  const c3 = -6 * v * v - 3 * v - 3 * v * v * v;
  const c4 = 1 + 3 * v + v * v * v + 3 * v * v;
  return values.map((_, i) => (e6[i] == null ? null : c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i]));
}

/**
 * T3 FAST / SLOW state on closed bars: bull = fast above slow, cross = +1 / -1 when the
 * fast line crossed the slow one within the last `recent` closed bars (0 otherwise).
 */
export function t3State(closes, { fast = 8, slow = 21, factor = 0.7, recent = 3 } = {}) {
  const f = t3(closes, fast, factor), s = t3(closes, slow, factor);
  const n = closes.length - 1;
  if (f[n] == null || s[n] == null || f[n - 1] == null || s[n - 1] == null) return null;
  let cross = 0, barsAgo = null;
  for (let i = n; i > Math.max(0, n - recent); i--) {
    if (f[i - 1] == null || s[i - 1] == null) break;
    if (f[i - 1] <= s[i - 1] && f[i] > s[i]) { cross = 1; barsAgo = n - i; break; }
    if (f[i - 1] >= s[i - 1] && f[i] < s[i]) { cross = -1; barsAgo = n - i; break; }
  }
  return { fast: f[n], slow: s[n], bull: f[n] > s[n], cross, cross_bars_ago: barsAgo, fast_slope: f[n] - f[n - 1] };
}
