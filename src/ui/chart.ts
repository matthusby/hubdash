import { TOKEN_KINDS, type BucketSize } from "../types.ts";
import * as fmt from "./format.ts";

export type TokenKind = (typeof TOKEN_KINDS)[number];

export const KIND_LABELS: Record<TokenKind, string> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
};

/** One stacked layer, bottom first. `color` is any CSS color, usually a `var(--slot-n)`. */
export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface ChartPoint {
  start: string;
  values: Record<string, number>;
}

export const pointTotal = (point: ChartPoint, series: Series[]): number =>
  series.reduce((sum, s) => sum + (point.values[s.key] ?? 0), 0);

const SVG = "http://www.w3.org/2000/svg";
const MARGIN = { top: 8, right: 4, bottom: 22, left: 44 };
const SEGMENT_GAP = 2;
const CAP_RADIUS = 4;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 1/2/5 × 10^n step giving at most ~4 gridlines. */
function niceStep(max: number): number {
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
}

/** A bar whose top corners are rounded; only the topmost segment of a stack gets one. */
function capPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(CAP_RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function renderChart(
  container: HTMLElement,
  points: ChartPoint[],
  series: Series[],
  size: BucketSize,
  emptyMessage: string,
  onHover: (index: number | null, event?: MouseEvent) => void,
): void {
  container.replaceChildren();
  const width = container.clientWidth;
  const height = container.clientHeight;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const max = Math.max(...points.map((p) => pointTotal(p, series)), 0);

  if (max === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }

  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;
  const band = plotW / points.length;
  const barW = Math.max(2, Math.min(band * 0.7, 36));

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Token usage chart" });

  for (let v = 0; v <= top; v += step) {
    svg.append(el("line", { class: "gridline", x1: MARGIN.left, x2: width - MARGIN.right, y1: y(v), y2: y(v) }));
    const label = el("text", { class: "axis", x: MARGIN.left - 8, y: y(v) + 4, "text-anchor": "end" });
    label.textContent = fmt.tokens(v);
    svg.append(label);
  }

  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 64))));

  points.forEach((point, i) => {
    const bandX = MARGIN.left + i * band;
    const x = bandX + (band - barW) / 2;

    const hit = el("rect", { class: "hit", x: bandX, y: MARGIN.top, width: band, height: plotH, rx: 6 });
    hit.addEventListener("mousemove", (e) => onHover(i, e));
    hit.addEventListener("mouseleave", () => onHover(null));
    svg.append(hit);

    const visible = series.filter((s) => (point.values[s.key] ?? 0) > 0);
    let base = 0;
    visible.forEach(({ key, color: fill }, j) => {
      const value = point.values[key] ?? 0;
      const y0 = y(base);
      const y1 = y(base + value);
      base += value;
      const isTop = j === visible.length - 1;
      const h = isTop ? Math.max(y0 - y1, 1) : y0 - y1 - SEGMENT_GAP;
      if (h <= 0) return;
      const segment = isTop
        ? el("path", { d: capPath(x, y1, barW, h), fill })
        : el("rect", { x, y: y1 + SEGMENT_GAP, width: barW, height: h, fill });
      segment.setAttribute("pointer-events", "none");
      svg.append(segment);
    });

    if (i % labelEvery === 0) {
      const label = el("text", { class: "axis", x: bandX + band / 2, y: height - 6, "text-anchor": "middle" });
      label.textContent = fmt.bucketLabel(point.start, size, true);
      svg.append(label);
    }
  });

  container.append(svg);
}
