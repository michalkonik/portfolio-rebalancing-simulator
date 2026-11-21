import { day } from "./format.ts";

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

const PAD_L = 76;
const PAD_T = 22;
const PAD_B = 32;

function finite(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value != null && Number.isFinite(value));
}

function domain(lines: ChartLine[]): { min: number; max: number } | null {
  const all = lines.flatMap((line) => finite(line.values));
  if (all.length === 0) return null;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    const bump = Math.abs(min) * 0.04 || 1;
    return { min: min - bump, max: max + bump };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function yFor(span: { min: number; max: number }, value: number, innerH: number): number {
  return PAD_T + (1 - (value - span.min) / (span.max - span.min)) * innerH;
}

export function renderLineChart(
  host: HTMLElement,
  times: number[],
  lines: ChartLine[],
  names: ChartScaleNames = { left: "USDT", right: "BTC price" },
): void {
  host.replaceChildren();
  const drawable = lines.filter((line) => finite(line.values).length > 0);
  if (drawable.length === 0 || times.length < 2) {
    host.textContent = "Turn a line on to draw the chart.";
    return;
  }
  const width = Math.max(360, host.clientWidth || 760);
  const height = 440;
  const dual = drawable.some((line) => line.axis === "left") && drawable.some((line) => line.axis === "right");
  const padR = dual ? 78 : 16;
  const innerW = width - PAD_L - padR;
  const innerH = height - PAD_T - PAD_B;
  const leftDomain = domain(dual ? drawable.filter((line) => line.axis === "left") : drawable);
  const rightDomain = dual ? domain(drawable.filter((line) => line.axis === "right")) : null;
  if (!leftDomain) {
    host.textContent = "Turn a line on to draw the chart.";
    return;
  }
  const x = (i: number) => PAD_L + (i / (times.length - 1)) * innerW;
  const yOf = (line: ChartLine, value: number) =>
    yFor(dual && line.axis === "right" && rightDomain ? rightDomain : leftDomain, value, innerH);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    dual ? `${names.left} and ${names.right} on a linear scale` : `${names.left} on a linear scale`,
  );

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  for (const tick of ticks) {
    const yy = PAD_T + tick * innerH;
    const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
    grid.setAttribute("x1", String(PAD_L));
    grid.setAttribute("x2", String(width - padR));
    grid.setAttribute("y1", String(yy));
    grid.setAttribute("y2", String(yy));
    grid.setAttribute("class", "grid");
    svg.append(grid);
    const left = document.createElementNS("http://www.w3.org/2000/svg", "text");
    left.setAttribute("x", "8");
    left.setAttribute("y", String(yy + 4));
    left.setAttribute("class", "axis");
    left.textContent = compact(leftDomain.min + (leftDomain.max - leftDomain.min) * (1 - tick));
    svg.append(left);
    if (dual && rightDomain) {
      const right = document.createElementNS("http://www.w3.org/2000/svg", "text");
      right.setAttribute("x", String(width - 8));
      right.setAttribute("y", String(yy + 4));
      right.setAttribute("text-anchor", "end");
      right.setAttribute("class", "axis");
      right.textContent = compact(rightDomain.min + (rightDomain.max - rightDomain.min) * (1 - tick));
      svg.append(right);
    }
  }

  const leftTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
  leftTitle.setAttribute("x", "8");
  leftTitle.setAttribute("y", "14");
  leftTitle.setAttribute("class", "axis-title");
  leftTitle.textContent = dual ? names.left : drawable.some((line) => line.axis === "right") && !drawable.some((line) => line.axis === "left") ? names.right : names.left;
  svg.append(leftTitle);
  if (dual) {
    const rightTitle = document.createElementNS("http://www.w3.org/2000/svg", "text");
    rightTitle.setAttribute("x", String(width - 8));
    rightTitle.setAttribute("y", "14");
    rightTitle.setAttribute("text-anchor", "end");
    rightTitle.setAttribute("class", "axis-title");
    rightTitle.textContent = names.right;
    svg.append(rightTitle);
  }

  for (const index of [0, Math.floor(times.length / 2), times.length - 1]) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x(index)));
    label.setAttribute("y", String(height - 8));
    label.setAttribute("class", "axis");
    label.setAttribute("text-anchor", index === 0 ? "start" : index === times.length - 1 ? "end" : "middle");
    label.textContent = day(times[index] ?? 0);
    svg.append(label);
  }

  for (const line of drawable) {
    let d = "";
    let pen = false;
    line.values.forEach((value, index) => {
      if (value == null || !Number.isFinite(value)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(index).toFixed(1)},${yOf(line, value).toFixed(1)} `;
      pen = true;
    });
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d.trim());
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", line.color);
    path.setAttribute("stroke-width", String(line.width ?? 1.6));
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    if (line.dash) path.setAttribute("stroke-dasharray", line.dash);
    svg.append(path);
  }

  const occupied: number[] = [];
  for (const line of drawable) {
    let y: number | null = null;
    for (let index = line.values.length - 1; index >= 0; index -= 1) {
      const value = line.values[index];
      if (value == null || !Number.isFinite(value)) continue;
      y = yOf(line, value);
      break;
    }
    if (y == null || y < PAD_T || y > height - PAD_B) continue;
    if (occupied.some((used) => Math.abs(used - y) < 13)) continue;
    occupied.push(y);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(width - padR - 6));
    text.setAttribute("y", String(y));
    text.setAttribute("text-anchor", "end");
    text.setAttribute("class", "line-label");
    text.setAttribute("fill", line.color);
    text.textContent = line.name;
    svg.append(text);
  }

  const hover = document.createElementNS("http://www.w3.org/2000/svg", "line");
  hover.setAttribute("class", "hover");
  hover.setAttribute("y1", String(PAD_T));
  hover.setAttribute("y2", String(height - PAD_B));
  hover.setAttribute("visibility", "hidden");
  svg.append(hover);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.append(svg, tip);

  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const rel = (event.clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(times.length - 1, Math.round((rel * width - PAD_L) / innerW * (times.length - 1))));
    hover.setAttribute("x1", String(x(index)));
    hover.setAttribute("x2", String(x(index)));
    hover.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = day(times[index] ?? 0);
    tip.append(title);
    for (const line of drawable) {
      const row = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = line.color;
      const value = line.values[index];
      row.append(swatch, document.createTextNode(`${line.name}  ${value == null ? "—" : line.label(value)}`));
      tip.append(row);
    }
    const left = Math.min(rect.width - 220, Math.max(8, event.clientX - rect.left + 14));
    tip.style.left = `${left}px`;
  });
  svg.addEventListener("pointerleave", () => {
    hover.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

export function renderStack(
  host: HTMLElement,
  times: number[],
  series: Array<{ name: string; color: string; values: number[] }>,
): void {
  host.replaceChildren();
  const width = Math.max(320, host.clientWidth || 720);
  const height = 180;
  const pad = { l: 76, r: 16, t: 16, b: 28 };
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
    path.setAttribute("fill-opacity", "0.85");
    svg.append(path);
  }
  host.append(svg);
}

function compact(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
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
