export function usdt(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 10000 ? 0 : abs >= 100 ? 2 : abs >= 1 ? 2 : 4;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits === 0 ? 0 : 2,
    maximumFractionDigits: digits,
  }).format(value);
  return `${formatted} USDT`;
}

export function pct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const scaled = value * 100;
  const sign = scaled > 0 ? "+" : "";
  return `${sign}${scaled.toFixed(digits)}%`;
}

export function num(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function qty(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value.toPrecision(4);
}

export function quote(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayInput(ms: number): string {
  return day(ms);
}

export function parseDayStart(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

export function parseDayEnd(value: string): number {
  return Date.parse(`${value}T23:59:59Z`);
}

export function cls(value: number | null): string {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 1e-12) return "";
  return value > 0 ? "pos" : "neg";
}
