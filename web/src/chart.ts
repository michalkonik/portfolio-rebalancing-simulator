import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";

export interface ChartLine {
  name: string;
  color: string;
  dash?: string;
  width?: number;
  /** Right-axis series keep their own linear scale when a left-axis series is also shown. */
  axis: "left" | "right";
  values: Array<number | null>;
  label: (value: number) => string;
}

export interface ChartScaleNames {
  left: string;
  right: string;
}

export type ValueScale = "usd" | "pct";

interface ChartHost extends HTMLElement {
  __chart?: IChartApi;
}

type LinePoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

function finite(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value != null && Number.isFinite(value));
}

function stamp(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

/** Drop leading empties so a coin that lists later does not start at zero and break the percent scale. */
function pointsFor(times: number[], values: Array<number | null>, fromMs?: number): LinePoint[] {
  const out: LinePoint[] = [];
  let started = false;
  for (let i = 0; i < times.length; i++) {
    const value = values[i];
    const time = stamp(times[i] ?? 0);
    if (!started) {
      if (value == null || !Number.isFinite(value)) continue;
      started = true;
    }
    if (value == null || !Number.isFinite(value)) {
      out.push({ time });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.time === time) continue;
    out.push({ time, value });
  }
  if (out.length === 0) return out;
  if (fromMs != null && stamp(fromMs) < out[0].time) {
    out.unshift({ time: stamp(fromMs) });
  }
  return out;
}

export function renderLineChart(
  host: HTMLElement,
  times: number[],
  lines: ChartLine[],
  names: ChartScaleNames = { left: "USDT", right: "BTC price" },
  options: { scale?: ValueScale; fromMs?: number; toMs?: number } = {},
): void {
  const box = host as ChartHost;
  box.__chart?.remove();
  box.__chart = undefined;
  host.replaceChildren();
  const drawable = lines.filter((line) => finite(line.values).length > 0);
  if (drawable.length === 0 || times.length < 2) {
    host.textContent = "Turn a line on to draw the chart.";
    return;
  }
  const scale = options.scale ?? "usd";
  const percent = scale === "pct";
  const hasRight = drawable.some((line) => line.axis === "right");
  const chart = createChart(host, {
    autoSize: true,
    height: 480,
    layout: {
      background: { type: ColorType.Solid, color: "#ffffff" },
      textColor: "#65748b",
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 12,
    },
    grid: {
      vertLines: { color: "#eef1f6" },
      horzLines: { color: "#eef1f6" },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "#0069d9", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#121828" },
      horzLine: { color: "#0069d9", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#121828" },
    },
    rightPriceScale: {
      borderColor: "#e6e8f0",
      visible: true,
      mode: percent ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    leftPriceScale: {
      borderColor: "#e6e8f0",
      visible: !percent && hasRight,
      mode: PriceScaleMode.Normal,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: "#e6e8f0",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 6,
      minBarSpacing: 0.02,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    kineticScroll: { touch: true, mouse: false },
    localization: {
      priceFormatter: (price: number) => formatUsd(price),
    },
  });
  box.__chart = chart;

  const seriesByName = new Map<string, { series: ISeriesApi<"Line">; label: (value: number) => string; color: string }>();
  for (const line of drawable) {
    const data = pointsFor(times, line.values, options.fromMs);
    if (data.length === 0) continue;
    const onRight = percent || line.axis !== "right";
    const series = chart.addSeries(LineSeries, {
      color: line.color,
      lineWidth: (line.width != null && line.width >= 2 ? 3 : 2),
      lineStyle: line.dash ? LineStyle.Dashed : LineStyle.Solid,
      priceScaleId: onRight ? "right" : "left",
      priceLineVisible: line.width != null && line.width >= 2,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      title: line.name,
    });
    series.setData(data);
    seriesByName.set(line.name, { series, label: line.label, color: line.color });
  }

  const legend = document.createElement("div");
  legend.className = "tv-legend";
  host.append(legend);
  const paintLegend = (time: number | null, rows: Array<{ name: string; color: string; text: string }>) => {
    legend.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = time == null ? (percent ? "% from first visible point" : names.left) : formatTime(time);
    legend.append(title);
    if (time == null) {
      const note = document.createElement("span");
      note.textContent = percent
        ? "Each line is its own percent change, like TradingView. Scroll rebases to the first point on screen."
        : `${names.left} on the right. ${hasRight ? `${names.right} on the left.` : ""}`.trim();
      legend.append(note);
    }
    for (const row of rows) {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = row.color;
      item.append(swatch, document.createTextNode(`${row.name}  ${row.text}`));
      legend.append(item);
    }
  };
  chart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.point) {
      paintLegend(null, []);
      return;
    }
    const rows: Array<{ name: string; color: string; text: string }> = [];
    for (const [name, item] of seriesByName) {
      const raw = param.seriesData.get(item.series);
      const value = raw && "value" in raw ? raw.value : null;
      let text = "—";
      if (value != null && Number.isFinite(value)) {
        text = percent ? formatPercent(value, firstVisible(chart, item.series)) : item.label(value);
      }
      rows.push({ name, color: item.color, text });
    }
    const ms = typeof param.time === "number" ? param.time * 1000 : Date.parse(String(param.time));
    paintLegend(Number.isFinite(ms) ? ms : null, rows);
  });
  paintLegend(null, []);

  chart.timeScale().fitContent();
  if (options.fromMs != null && options.toMs != null && options.toMs > options.fromMs) {
    try {
      chart.timeScale().setVisibleRange({ from: stamp(options.fromMs), to: stamp(options.toMs) });
    } catch {
      chart.timeScale().fitContent();
    }
  }
}

/** Same base TradingView uses: the first visible point of this line. */
function firstVisible(chart: IChartApi, series: ISeriesApi<"Line">): number | null {
  const range = chart.timeScale().getVisibleRange();
  const from = range?.from;
  for (const row of series.data()) {
    if (!("value" in row) || !Number.isFinite(row.value) || row.value === 0) continue;
    if (from == null || row.time >= from) return row.value;
  }
  return null;
}

function formatPercent(value: number, base: number | null): string {
  if (base == null || base === 0) return formatUsd(value);
  const change = (100 * (value - base)) / Math.abs(base);
  const sign = change > 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function renderStack(
  host: HTMLElement,
  times: number[],
  series: Array<{ name: string; color: string; values: number[] }>,
): void {
  host.replaceChildren();
  const width = Math.max(320, host.clientWidth || 720);
  const height = 180;
  const pad = { l: 8, r: 8, t: 8, b: 8 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  if (times.length < 2 || series.length === 0) return;
  const x = (i: number) => pad.l + (i / (times.length - 1)) * innerW;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Weight mix over time");
  for (let s = 0; s < series.length; s++) {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < times.length; i++) {
      let below = 0;
      for (let k = 0; k < s; k++) below += series[k].values[i] ?? 0;
      const value = series[s].values[i] ?? 0;
      const y0 = pad.t + (1 - below) * innerH;
      const y1 = pad.t + (1 - (below + value)) * innerH;
      top.push(`${x(i).toFixed(1)},${y1.toFixed(1)}`);
      bottom.push(`${x(i).toFixed(1)},${y0.toFixed(1)}`);
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M${top.join(" L")} L${bottom.reverse().join(" L")} Z`);
    path.setAttribute("fill", series[s].color);
    path.setAttribute("fill-opacity", "0.9");
    svg.append(path);
  }
  host.append(svg);
}

/** Plot the extremes of the first line in each bucket so drawdowns survive downsampling. */
export function envelope(times: number[], lines: ChartLine[], buckets = 360): { times: number[]; lines: ChartLine[] } {
  if (times.length <= buckets) return { times, lines };
  const size = Math.ceil(times.length / buckets);
  const picked: number[] = [];
  for (let start = 0; start < times.length; start += size) {
    const end = Math.min(times.length, start + size);
    let minI = start;
    let maxI = start;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = start; i < end; i++) {
      const value = lines[0]?.values[i];
      if (value == null || !Number.isFinite(value)) continue;
      if (value < minV) {
        minV = value;
        minI = i;
      }
      if (value > maxV) {
        maxV = value;
        maxI = i;
      }
    }
    picked.push(start, minI, maxI, end - 1);
  }
  const indexes = [...new Set(picked)].sort((a, b) => a - b);
  return {
    times: indexes.map((index) => times[index]),
    lines: lines.map((line) => ({ ...line, values: indexes.map((index) => line.values[index]) })),
  };
}
