import { day } from "./format.ts";

export interface ChartLine {
  name: string;
  color: string;
  dash?: string;
  values: Array<number | null>;
}

const PAD = { l: 64, r: 16, t: 16, b: 28 };

function finite(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value != null && Number.isFinite(value));
}

export function renderLineChart(host: HTMLElement, times: number[], lines: ChartLine[]): void {
  host.replaceChildren();
  const width = Math.max(320, host.clientWidth || 720);
  const height = 320;
  const innerW = width - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  const all = lines.flatMap((line) => finite(line.values));
  if (all.length === 0 || times.length < 2) {
    host.textContent = "No curve to draw.";
    return;
  }
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min *= 0.98;
    max *= 1.02;
  }
  const pad = (max - min) * 0.06;
  min -= pad;
  max += pad;
  const x = (i: number) => PAD.l + (i / (times.length - 1)) * innerW;
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * innerH;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Portfolio value over time");

  for (const tick of [0, 0.5, 1]) {
    const value = min + (max - min) * (1 - tick);
    const yy = PAD.t + tick * innerH;
    const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
    grid.setAttribute("x1", String(PAD.l));
    grid.setAttribute("x2", String(width - PAD.r));
    grid.setAttribute("y1", String(yy));
    grid.setAttribute("y2", String(yy));
    grid.setAttribute("class", "grid");
    svg.append(grid);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "8");
    label.setAttribute("y", String(yy + 4));
    label.setAttribute("class", "axis");
    label.textContent = compact(value);
    svg.append(label);
  }
  for (const index of [0, Math.floor(times.length / 2), times.length - 1]) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x(index)));
    label.setAttribute("y", String(height - 8));
    label.setAttribute("class", "axis");
    label.setAttribute("text-anchor", index === 0 ? "start" : index === times.length - 1 ? "end" : "middle");
    label.textContent = day(times[index]);
    svg.append(label);
  }

  for (const line of lines) {
    let d = "";
    let pen = false;
    line.values.forEach((value, index) => {
      if (value == null || !Number.isFinite(value)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
      pen = true;
    });
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d.trim());
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", line.color);
    path.setAttribute("stroke-width", line.name === "Strategy" ? "2.2" : "1.4");
    if (line.dash) path.setAttribute("stroke-dasharray", line.dash);
    svg.append(path);
  }

  const hover = document.createElementNS("http://www.w3.org/2000/svg", "line");
  hover.setAttribute("class", "hover");
  hover.setAttribute("y1", String(PAD.t));
  hover.setAttribute("y2", String(height - PAD.b));
  hover.setAttribute("visibility", "hidden");
  svg.append(hover);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  host.append(svg, tip);

  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const rel = (event.clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(times.length - 1, Math.round(rel * (times.length - 1))));
    hover.setAttribute("x1", String(x(index)));
    hover.setAttribute("x2", String(x(index)));
    hover.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = day(times[index]);
    tip.append(title);
    for (const line of lines) {
      const row = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = line.color;
      const value = line.values[index];
      row.append(swatch, document.createTextNode(`${line.name} ${value == null ? "—" : compact(value)}`));
      tip.append(row);
    }
    const left = Math.min(rect.width - 180, Math.max(8, event.clientX - rect.left + 12));
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
  const innerW = width - PAD.l - PAD.r;
  const innerH = height - PAD.t - PAD.b;
  if (times.length < 2 || series.length === 0) return;
  const x = (i: number) => PAD.l + (i / (times.length - 1)) * innerW;
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
      const y0 = PAD.t + (1 - below) * innerH;
      const y1 = PAD.t + (1 - (below + value)) * innerH;
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
